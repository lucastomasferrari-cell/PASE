import { useState, useEffect } from "react";
import { db } from "../lib/supabase";
import { applyLocalScope, cuentasOperables, localesVisibles, tienePermiso } from "../lib/auth";
import { translateRpcError } from "../lib/errors";
import { useCategorias } from "../lib/useCategorias";
import { useRealtimeTable } from "../lib/useRealtimeTable";
import { CUENTAS } from "../lib/constants";
import { toISO, today, fmt_d, fmt_$, genId, parseMonto, estadoFactura } from "../lib/utils";
import type { Usuario, Local } from "../types";
import type { Proveedor, Factura, PagoFactura } from "../types/finanzas";
import type { Remito, FormFactura, FormRemito, FormPagoRemito, ItemFactura } from "./compras/types";
import { estadoDot } from "./compras/helpers";
import { ModalPagarFactura } from "./compras/ModalPagarFactura";
import { ModalLectorIA } from "./compras/ModalLectorIA";
import { ModalVerFactura } from "./compras/ModalVerFactura";
import { ModalCargarFactura } from "./compras/ModalCargarFactura";
import { ModalCargarRemito } from "./compras/ModalCargarRemito";
import { ModalVincularRemito } from "./compras/ModalVincularRemito";
import { ModalPagarRemitoDirecto } from "./compras/ModalPagarRemitoDirecto";

interface ComprasProps {
  user: Usuario;
  locales: Local[];
  localActivo: number | null;
}

export default function Compras({ user, locales, localActivo }: ComprasProps) {
  const { CATEGORIAS_COMPRA, GASTOS_FIJOS, GASTOS_VARIABLES, GASTOS_PUBLICIDAD, COMISIONES_CATS, GASTOS_IMPUESTOS, categoriaToBucket } = useCategorias();
  // Cuentas para el dropdown de "Cuenta de egreso" en el modal de pago.
  // Filtra por cuentas_operables (no por cuentas_visibles): un encargado
  // puede tener permiso de pagar contra una cuenta cuyo saldo no ve.
  const opCuentas = cuentasOperables(user);
  const cuentasUsables = opCuentas === null ? CUENTAS : CUENTAS.filter(c => opCuentas.includes(c));
  const puedeFacturas = tienePermiso(user, "compras");
  const puedeRemitos  = tienePermiso(user, "remitos");
  const [facturas, setFacturas] = useState<Factura[]>([]);
  const [remitos, setRemitos] = useState<Remito[]>([]);
  const [proveedores, setProveedores] = useState<Proveedor[]>([]);
  const [search, setSearch] = useState("");
  // Default: últimos 90 días. Antes era inicio del mes (~15 días promedio)
  // pero los usuarios reportaron faltarles facturas viejas — mejor mostrar
  // 3 meses por default y que filtren manual si quieren ventana más chica.
  const [desde, setDesde] = useState(() => { const d = new Date(today); d.setDate(d.getDate() - 90); return toISO(d); });
  const [hasta, setHasta] = useState(toISO(today));
  const [provFiltro, setProvFiltro] = useState("");
  // Si el user solo tiene permiso de remitos, default al pill remitos.
  const [pillEstado, setPillEstado] = useState<string>(puedeFacturas ? "todas" : "remitos");
  // Estados para los flows de remito (modales y form).
  const [remModal, setRemModal] = useState(false);
  const [vincModal, setVincModal] = useState<Remito | null>(null);
  const [pagarRemModal, setPagarRemModal] = useState<Remito | null>(null);
  const [pagandoRem, setPagandoRem] = useState(false);
  // monto: number con CurrencyInput (sprint CurrencyInput).
  const emptyRemForm: FormRemito = { prov_id: "", local_id: localActivo ? String(localActivo) : "", nro: "", fecha: toISO(today), monto: 0, cat: "", detalle: "" };
  const [remForm, setRemForm] = useState<FormRemito>(emptyRemForm);
  const [remPagoForm, setRemPagoForm] = useState<FormPagoRemito>({ cuenta: "", monto: 0, fecha: toISO(today) });

  useEffect(() => {
    if (remPagoForm.cuenta && !cuentasUsables.includes(remPagoForm.cuenta)) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setRemPagoForm(p => ({ ...p, cuenta: "" }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remPagoForm.cuenta, cuentasUsables.join("|")]);
  const [lectorModal, setLectorModal] = useState(false);
  const [modal, setModal] = useState(false);
  const [pagarModal, setPagarModal] = useState<Factura | null>(null);
  // Idempotency keys (convención C1): se regeneran al abrir cada modal de
  // pago. Si el operador hace doble-click en "Confirmar", la 2da llamada
  // con la misma key devuelve el resultado cacheado (no duplica el pago).
  const [idempKeyPagarFac, setIdempKeyPagarFac] = useState<string>(() => crypto.randomUUID());
  const [idempKeyPagarRem, setIdempKeyPagarRem] = useState<string>(() => crypto.randomUUID());
  // NCs disponibles del proveedor de la factura abierta + saldo restante de
  // cada una. Saldo viene del frontend: nc.total - SUM(pagos[]) — los pagos
  // ya incluyen las aplicaciones previas (tipo='nc').
  // El usuario marca cuáles aplicar y con qué monto. Al confirmar se llaman
  // las RPCs aplicar_nc_a_factura por cada una y pagar_factura por el resto.
  const [ncsAplicar, setNcsAplicar] = useState<Record<string, number>>({});
  const [verModal, setVerModal] = useState<Factura | null>(null);
  const [loading, setLoading] = useState(true);
  const [pagando, setPagando] = useState(false);
  const [saving, setSaving] = useState(false);

  const emptyForm: FormFactura = { prov_id: "", local_id: localActivo ? String(localActivo) : "", nro: "", fecha: toISO(today), venc: "", neto: 0, iva21: 0, iva105: 0, iibb: 0, perc_iva: 0, otros_cargos: 0, descuentos: 0, cat: "", detalle: "", tipo: "factura" };
  const [form, setForm] = useState<FormFactura>(emptyForm);
  const [items, setItems] = useState<ItemFactura[]>([]);
  // Bug Caja-1: el default cuenta="MercadoPago" pisaba la elección del
  // usuario cuando MP no estaba en cuentasUsables (encargados con cuentas
  // restringidas). Default vacío fuerza la elección consciente.
  const [pagoForm, setPagoForm] = useState<{ cuenta: string; monto: number; fecha: string }>({ cuenta: "", monto: 0, fecha: toISO(today) });

  // Defensive: si form.cuenta queda con un valor que no está en
  // cuentasUsables (regression future, scope change), reseteamos a ""
  // para que el placeholder del <select> aparezca. NO borrar — previene
  // el retorno del bug Caja-1.
  useEffect(() => {
    if (pagoForm.cuenta && !cuentasUsables.includes(pagoForm.cuenta)) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPagoForm(p => ({ ...p, cuenta: "" }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pagoForm.cuenta, cuentasUsables.join("|")]);
  // Reportado 2026-05-06: el filtro `user.rol === "dueno"` excluía admin/
  // superadmin. Ahora usa el helper canónico que cubre todos los casos.
  const visLocs = localesVisibles(user);
  const localesDisp = visLocs === null ? locales : locales.filter((l: Local) => visLocs.includes(l.id));
  // CurrencyInput entrega number directo — no necesita parseMonto.
  const calcTotal = () =>
    form.neto + form.iva21 + form.iva105 + form.iibb + form.perc_iva +
    form.otros_cargos - form.descuentos;

  const load = async () => {
    setLoading(true);
    let fq = db.from("facturas").select("*").order("fecha", { ascending: false });
    fq = applyLocalScope(fq, user, localActivo);
    let rq = db.from("remitos").select("*").order("fecha", { ascending: false });
    rq = applyLocalScope(rq, user, localActivo);
    const [{ data: f }, { data: r }, { data: p }] = await Promise.all([
      fq,
      rq,
      db.from("proveedores").select("*").eq("estado", "Activo").order("nombre"),
    ]);
    setFacturas((f as Factura[]) || []);
    setRemitos((r as Remito[]) || []);
    setProveedores((p as Proveedor[]) || []);
    setLoading(false);
  };
  // Patrón fetch-on-dep-change.
  // eslint-disable-next-line react-hooks/set-state-in-effect, react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [localActivo]);

  // Sprint Realtime: cambios remotos en facturas, remitos o proveedores
  // del mismo tenant disparan reload. Cubre el flow de "carga manual de
  // factura en una compu, otra debe ver el cambio sin F5".
  useRealtimeTable({ table: 'facturas', onChange: () => load() });
  useRealtimeTable({ table: 'remitos', onChange: () => load() });
  useRealtimeTable({ table: 'proveedores', onChange: () => load() });

  // BUG 1: Lector IA modal solo cierra con X o ESC, no con click en backdrop.
  useEffect(() => {
    if (!lectorModal) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setLectorModal(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lectorModal]);

  const fFilt = facturas.filter(f => {
    if (f.estado === "anulada") return false;
    const isNC = (f.tipo || "factura") === "nota_credito";
    // Tab semantics:
    //  - "todas": facturas + NC mezcladas por fecha
    //  - "pendiente"/"vencida"/"pagada": solo facturas con ese estado
    //  - "nc": solo notas de crédito
    // Bug #32: antes la sección filtraba NC siempre, dejándolas invisibles
    // del listado de Compras aunque en Proveedores → Estado de Cuenta
    // aparecían en "NC Disponibles". Anto cargaba una NC y creía que se
    // había perdido.
    if (pillEstado === "nc") {
      if (!isNC) return false;
    } else if (pillEstado === "todas") {
      // pasa todo (factura o NC)
    } else {
      if (isNC) return false;
      // estadoFactura() deriva "vencida" cuando estado=pendiente y la fecha
      // de vencimiento ya pasó. Permite filtrar correctamente sin depender
      // de un trigger SQL que mantenga el campo estado actualizado.
      if (estadoFactura(f) !== pillEstado) return false;
    }
    if (localActivo && String(f.local_id) !== String(localActivo)) return false;
    if (provFiltro && String(f.prov_id) !== String(provFiltro)) return false;
    if (desde && f.fecha < desde) return false;
    if (hasta && f.fecha > hasta) return false;
    if (search) {
      const prov = proveedores.find(p => p.id === f.prov_id);
      const matchProv = prov?.nombre.toLowerCase().includes(search.toLowerCase());
      const matchNro = (f.nro || "").toLowerCase().includes(search.toLowerCase());
      if (!matchProv && !matchNro) return false;
    }
    return true;
  });

  const onProvChange = (prov_id: string) => {
    const prov = proveedores.find(p => p.id === parseInt(prov_id));
    setForm(f => ({ ...f, prov_id, cat: prov?.cat || f.cat }));
  };

  const addItem = () => setItems([...items, { producto: "", cantidad: "", unidad: "kg", precio_unitario: "", subtotal: 0 }]);
  const updateItem = (i: number, field: keyof ItemFactura, val: string | number) => {
    const current = items[i];
    if (!current) return;
    const updated: ItemFactura = { ...current, [field]: val };
    if (field === "cantidad" || field === "precio_unitario") {
      const q = parseMonto(field === "cantidad" ? val : updated.cantidad);
      const p = parseMonto(field === "precio_unitario" ? val : updated.precio_unitario);
      updated.subtotal = q * p;
    }
    const newItems = [...items];
    newItems[i] = updated;
    setItems(newItems);
  };
  const removeItem = (i: number) => setItems(items.filter((_, idx) => idx !== i));

  const guardar = async () => {
    if (saving) return;
    if (!form.prov_id) { alert("Seleccioná un proveedor"); return; }
    if (!form.nro) { alert("Ingresá el número de factura"); return; }
    if (form.neto <= 0) { alert("Ingresá el neto gravado"); return; }
    if (!form.local_id) { alert("Seleccioná un local"); return; }
    const isNC = form.tipo === "nota_credito";
    const totalAbs = calcTotal();
    const total = isNC ? -Math.abs(totalAbs) : totalAbs;

    // Warning de duplicados (bug #29): mismo proveedor, misma fecha, total
    // dentro de ±1%. Detecta dupes por typo (ej: "00003-00015" vs
    // "00003-00000515"). El chequeo respeta RLS — si el user tiene scope
    // de locales restringido, sólo ve las suyas.
    if (form.fecha && form.prov_id) {
      const { data: posibles } = await db.from("facturas")
        .select("nro, fecha, total, estado, tipo")
        .eq("prov_id", parseInt(form.prov_id))
        .eq("fecha", form.fecha)
        .neq("estado", "anulada");
      const dup = (posibles || []).find(p => {
        const diff = Math.abs(Number(p.total || 0) - total);
        const tol = Math.max(1, Math.abs(total) * 0.01);
        return diff <= tol && (p.tipo || "factura") === form.tipo;
      });
      if (dup) {
        const prov = proveedores.find(p => p.id === parseInt(form.prov_id));
        const ok = confirm(
          `Ya existe una factura similar:\n\n` +
          `  ${dup.nro} · ${fmt_d(dup.fecha)} · ${fmt_$(Number(dup.total))}\n` +
          `  ${prov?.nombre || ""}\n\n` +
          `¿Querés cargar esta igualmente?`,
        );
        if (!ok) return;
      }
    }

    setSaving(true);
    try {
      const id = genId(isNC ? "NC" : "FACT");
      // Campos date: "" → null. Postgres rechaza string vacío en columnas
      // date con "invalid input syntax for type date: \"\"". Común en NC
      // que no siempre tienen vencimiento.
      // CurrencyInput entrega number directo — no necesita parseMonto.
      // bucket: deriva del tipo crudo de la cat en config_categorias
      // (cat_compra | gasto_fijo | gasto_variable | gasto_publicidad |
      // gasto_comision | gasto_impuesto). Si la cat no está mapeada (libre
      // o legacy), bucket queda null y EERR la trata como CMV.
      const bucket = form.cat ? (categoriaToBucket[form.cat] ?? null) : null;
      const nueva = { ...form, id, prov_id: parseInt(form.prov_id), local_id: parseInt(form.local_id), total, estado: "pendiente", pagos: [], tipo: form.tipo, fecha: form.fecha || null, venc: form.venc || null, bucket };
      // eslint-disable-next-line pase-local/no-direct-financiera-write -- deuda C4-F12: factura + factura_items deben fusionarse en RPC crear_factura_completa (atómica). El trigger trg_saldo_proveedor cubre proveedor.saldo OK, pero si falla el INSERT de items queda factura sin detalle.
      const { error: factErr } = await db.from("facturas").insert([nueva]);
      if (factErr) throw new Error("Error guardando factura: " + factErr.message);

      if (items.length > 0) {
        const itemsToInsert = items.filter(it => it.producto).map(it => ({ ...it, factura_id: id, cantidad: parseMonto(it.cantidad), precio_unitario: parseMonto(it.precio_unitario), subtotal: it.subtotal }));
        // eslint-disable-next-line pase-local/no-direct-financiera-write -- deuda C4-F12: parte del flow no-atómico (ver línea anterior).
        if (itemsToInsert.length > 0) await db.from("factura_items").insert(itemsToInsert);
      }
      // El trigger trg_saldo_prov_facturas (migration 202605070900) recalcula
      // proveedores.saldo automáticamente al insertar la factura/NC. Antes
      // este flow hacía un UPDATE manual con race condition latente.
      setModal(false); setForm(emptyForm); setItems([]); load();
    } catch (err) {
      console.error("Error guardando factura:", err);
      alert("Error al guardar: " + (err instanceof Error ? err.message : String(err)));
    } finally {
      setSaving(false);
    }
  };

  const pagar = async () => {
    if (pagando || !pagarModal) return;
    setPagando(true);
    try {
      const f = pagarModal;
      const prov = proveedores.find(p => p.id === f.prov_id);
      const detalle = `Pago ${prov?.nombre || ""} - Fact ${f.nro}`;

      // 1) Aplicar NCs seleccionadas. Cada una en su propia llamada RPC para
      //    que el error de una no rompa las otras (la transacción de cada
      //    aplicación es atómica del lado servidor).
      const ncEntries = Object.entries(ncsAplicar).filter(([, m]) => m > 0);
      const totalNcAplicado = ncEntries.reduce((s, [, m]) => s + m, 0);
      for (const [nc_id, monto] of ncEntries) {
        const { error: ncErr } = await db.rpc("aplicar_nc_a_factura", {
          p_nc_id: nc_id,
          p_factura_id: f.id,
          p_monto: monto,
          p_fecha: pagoForm.fecha,
        });
        if (ncErr) throw ncErr;
      }

      // 2) Pagar el resto con plata si queda saldo. Si solo se aplicaron NCs
      //    y la factura ya queda saldada, se omite pagar_factura.
      const restanteAPagar = pagoForm.monto > 0 ? pagoForm.monto : Math.max(0, f.total - totalNcAplicado);
      if (restanteAPagar > 0) {
        if (!pagoForm.cuenta) {
          alert("Elegí una cuenta de egreso para el saldo restante");
          setPagando(false);
          return;
        }
        const { error } = await db.rpc("pagar_factura", {
          p_factura_id: f.id,
          p_monto: restanteAPagar,
          p_cuenta: pagoForm.cuenta,
          p_fecha: pagoForm.fecha,
          p_detalle: detalle,
          p_idempotency_key: idempKeyPagarFac,
        });
        if (error) throw error;
      } else if (totalNcAplicado === 0) {
        // Ni NCs ni plata → nada que hacer.
        alert("Indicá un pago con plata o aplicá una NC");
        setPagando(false);
        return;
      }

      setPagarModal(null);
      setNcsAplicar({});
      load();
    } catch (err) {
      console.error("Error en pagar:", err);
      alert(translateRpcError(err));
    } finally {
      setPagando(false);
    }
  };

  const anular = async (f: Factura) => {
    if (!confirm(`¿Anular factura ${f.nro}? Esta acción queda registrada.`)) return;
    const motivo = prompt("Motivo (opcional):") || "Anulada desde UI";
    const { error } = await db.rpc("anular_factura", { p_factura_id: f.id, p_motivo: motivo });
    if (error) { alert(translateRpcError(error)); return; }
    load();
  };

  // ─── Remitos ────────────────────────────────────────────────────────────
  // Lógica heredada de Remitos.tsx (eliminado 2026-05-07). Mismas RPCs:
  // pagar_remito y anular_remito. La inserción es un INSERT directo; los
  // triggers de migration 202605070900 actualizan proveedores.saldo.

  const onRemProvChange = (prov_id: string) => {
    const prov = proveedores.find(p => p.id === parseInt(prov_id));
    setRemForm(f => ({ ...f, prov_id, cat: prov?.cat || f.cat }));
  };

  const guardarRemito = async () => {
    if (remForm.monto <= 0 || !remForm.local_id) return;
    const nro = remForm.nro || `REM-${Date.now().toString().slice(-6)}`;
    const nuevo = {
      ...remForm, id: genId("REM"),
      prov_id: remForm.prov_id ? parseInt(remForm.prov_id) : null,
      local_id: parseInt(String(remForm.local_id)),
      nro, monto: remForm.monto,
      estado: "sin_factura", factura_id: null,
    };
    // eslint-disable-next-line pase-local/no-direct-financiera-write -- deuda C4-F12: cargar remito debe ir por RPC crear_remito atómica. Hoy el trigger trg_saldo_proveedor cubre proveedor.saldo, pero el control de duplicados queda client-side.
    await db.from("remitos").insert([nuevo]);
    setRemModal(false); setRemForm(emptyRemForm); load();
  };

  const vincularRemitoAFactura = async (fid: string) => {
    const r = vincModal;
    if (!r) return;
    // eslint-disable-next-line pase-local/no-direct-financiera-write -- deuda C4-F12: vincular remito↔factura debe pasar por RPC vincular_remito que valide consistencia (proveedor, monto) atomicamente.
    await db.from("remitos").update({ estado: "vinculado", factura_id: fid }).eq("id", r.id);
    setVincModal(null); load();
  };

  const pagarRemito = async () => {
    if (pagandoRem || !pagarRemModal) return;
    if (!remPagoForm.cuenta) { alert("Elegí una cuenta de egreso"); return; }
    setPagandoRem(true);
    try {
      const r = pagarRemModal;
      const monto = remPagoForm.monto > 0 ? remPagoForm.monto : r.monto;
      const { error } = await db.rpc("pagar_remito", {
        p_remito_id: r.id, p_monto: monto,
        p_cuenta: remPagoForm.cuenta, p_fecha: remPagoForm.fecha,
        p_idempotency_key: idempKeyPagarRem,
      });
      if (error) throw error;
      setPagarRemModal(null); load();
    } catch (err) {
      console.error("Error pagando remito:", err);
      alert(translateRpcError(err));
    } finally {
      setPagandoRem(false);
    }
  };

  const anularRemito = async (r: Remito) => {
    if (!confirm(`¿Anular remito ${r.nro}?`)) return;
    const motivo = prompt("Motivo (opcional):") || "Anulado desde UI";
    const { error } = await db.rpc("anular_remito", { p_remito_id: r.id, p_motivo: motivo });
    if (error) { alert(translateRpcError(error)); return; }
    load();
  };

  // Filtro de remitos respeta el local activo del sidebar y el provFiltro.
  const rFilt = remitos.filter(r => {
    if (localActivo && String(r.local_id) !== String(localActivo)) return false;
    if (provFiltro && String(r.prov_id) !== String(provFiltro)) return false;
    if (search) {
      const prov = proveedores.find(p => p.id === r.prov_id);
      const matchProv = prov?.nombre.toLowerCase().includes(search.toLowerCase());
      const matchNro = (r.nro || "").toLowerCase().includes(search.toLowerCase());
      if (!matchProv && !matchNro) return false;
    }
    if (desde && r.fecha < desde) return false;
    if (hasta && r.fecha > hasta) return false;
    return true;
  });

  return (
    <div>
      <div className="ph-row">
        <div>
          <div className="ph-title">Compras</div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          {puedeFacturas && <button className="btn btn-sec" onClick={() => setLectorModal(true)}>Lector IA</button>}
          {puedeRemitos && (
            <button className="btn btn-sec" onClick={() => { setRemForm({ ...emptyRemForm, local_id: localActivo ? String(localActivo) : "" }); setRemModal(true); }}>+ Cargar Remito</button>
          )}
          {puedeFacturas && (
            <button className="btn btn-acc" onClick={() => { setForm({ ...emptyForm, local_id: localActivo ? String(localActivo) : "" }); setItems([]); setModal(true); }}>+ Cargar Factura</button>
          )}
        </div>
      </div>

      {/* Filtros */}
      <div style={{ display: "flex", gap: 8, marginBottom: 14, alignItems: "center", flexWrap: "wrap" }}>
        <input className="search" placeholder="Buscar proveedor o Nº..." value={search} onChange={e => setSearch(e.target.value)} style={{ width: 200 }} />
        <div style={{ width: 1, height: 22, background: "var(--bd)" }} />
        <input type="date" className="search" value={desde} onChange={e => setDesde(e.target.value)} style={{ width: 145 }} />
        <span style={{ fontSize: 12, color: "var(--muted2)" }}>→</span>
        <input type="date" className="search" value={hasta} onChange={e => setHasta(e.target.value)} style={{ width: 145 }} />
        <div style={{ width: 1, height: 22, background: "var(--bd)" }} />
        <select className="search" value={provFiltro} onChange={e => setProvFiltro(e.target.value)} style={{ width: 200 }}>
          <option value="">Todos los proveedores</option>
          {proveedores.map(p => <option key={p.id} value={p.id}>{p.nombre}</option>)}
        </select>
      </div>

      {/* Banner de deuda acumulada cuando hay proveedor filtrado (Bug #25) */}
      {provFiltro && (() => {
        const prov = proveedores.find(p => String(p.id) === String(provFiltro));
        const deuda = facturas.filter(f =>
          String(f.prov_id) === String(provFiltro) &&
          (f.tipo || "factura") === "factura" &&
          (f.estado === "pendiente" || f.estado === "vencida"),
        );
        const pendientes = deuda.filter(f => estadoFactura(f) === "pendiente");
        const vencidas = deuda.filter(f => estadoFactura(f) === "vencida");
        const totalPend = pendientes.reduce((s, f) => s + Number(f.total || 0), 0);
        const totalVenc = vencidas.reduce((s, f) => s + Number(f.total || 0), 0);
        const totalAll = totalPend + totalVenc;
        if (deuda.length === 0) {
          return (
            <div className="alert alert-info" style={{ marginBottom: 14, fontSize: 12 }}>
              {prov?.nombre || "Proveedor"} sin facturas pendientes.
            </div>
          );
        }
        return (
          <div className="alert alert-warn" style={{ marginBottom: 14, fontSize: 12, display: "flex", gap: 20, flexWrap: "wrap", alignItems: "baseline" }}>
            <span><strong>{prov?.nombre || "Proveedor"}</strong> — deuda pendiente: <strong style={{ color: "var(--warn)" }}>{fmt_$(totalAll)}</strong> ({deuda.length} factura{deuda.length === 1 ? "" : "s"})</span>
            <span style={{ color: "var(--muted2)" }}>
              Pendientes: <span style={{ color: "var(--warn)" }}>{fmt_$(totalPend)}</span> ({pendientes.length})
              {vencidas.length > 0 && <> · Vencidas: <span style={{ color: "var(--danger)" }}>{fmt_$(totalVenc)}</span> ({vencidas.length})</>}
            </span>
          </div>
        );
      })()}

      {/* Pills — facturas + (opcional) remitos.
          Si user solo tiene permiso de remitos, NO mostramos los pills de
          facturas (state default ya queda en "remitos"). */}
      <div className="pills">
        {puedeFacturas && (
          ([["todas", "Todas"], ["pendiente", "Pendientes"], ["vencida", "Vencidas"], ["pagada", "Pagadas"], ["nc", "Notas de Crédito"]] as [string, string][]).map(([id, l]) => (
            <div key={id} className={`pill ${pillEstado === id ? "active" : ""}`} onClick={() => setPillEstado(id)}>{l}</div>
          ))
        )}
        {puedeRemitos && (
          <div className={`pill ${pillEstado === "remitos" ? "active" : ""}`} onClick={() => setPillEstado("remitos")}>Remitos</div>
        )}
      </div>

      {/* Tabla — switch entre facturas y remitos según pillEstado. */}
      {pillEstado === "remitos" ? (
        <div className="panel">
          {loading ? <div className="loading">Cargando...</div> : rFilt.length === 0 ? <div className="empty">No hay remitos con esos filtros</div> : (
            <table>
              <thead><tr>
                <th>Proveedor · Nº</th>
                {!localActivo && <th>Local</th>}
                <th>Fecha</th>
                <th>Categoría</th>
                <th style={{ textAlign: "right" }}>Monto</th>
                <th>Estado</th>
                <th></th>
              </tr></thead>
              <tbody>{rFilt.map(r => {
                const prov = proveedores.find(p => p.id === r.prov_id);
                const isAnulado = r.estado === "anulado";
                return (
                  <tr key={r.id} className={isAnulado ? "anulada-row" : ""}>
                    <td>
                      <div style={{ fontSize: 12, fontWeight: 500, color: "var(--txt)" }}>{prov?.nombre || "—"}</div>
                      <div style={{ fontSize: 10, color: "var(--muted2)", marginTop: 1 }}>{r.nro}</div>
                    </td>
                    {!localActivo && (
                      <td><span className="badge b-muted" style={{ fontSize: 10 }}>{locales.find((l: Local) => l.id === r.local_id)?.nombre || "—"}</span></td>
                    )}
                    <td className="mono">{fmt_d(r.fecha)}</td>
                    <td><span className="badge b-muted">{r.cat || "—"}</span></td>
                    <td style={{ textAlign: "right" }}><span className="num kpi-warn">{fmt_$(r.monto)}</span></td>
                    <td>
                      {r.estado === "sin_factura" && <span className="badge b-warn">Sin Factura</span>}
                      {(r.estado === "facturado" || r.estado === "vinculado") && <span className="badge b-success">Vinculado</span>}
                      {r.estado === "pagado" && <span className="badge b-info">Pagado</span>}
                      {r.estado === "anulado" && <span className="badge b-anulada">Anulado</span>}
                    </td>
                    <td>
                      {!isAnulado && (
                        <div style={{ display: "flex", gap: 4, alignItems: "center", justifyContent: "flex-end" }}>
                          {r.estado === "sin_factura" && <button className="btn btn-ghost btn-sm" onClick={() => setVincModal(r)}>Vincular FC</button>}
                          {r.factura_id && <span className="mono" style={{ fontSize: 10, color: "var(--info)" }}>→ {facturas.find(f => f.id === r.factura_id)?.nro || r.factura_id}</span>}
                          {r.estado === "sin_factura" && <button className="btn btn-success btn-sm" onClick={() => { setPagarRemModal(r); setRemPagoForm({ cuenta: "", monto: r.monto, fecha: toISO(today) }); setIdempKeyPagarRem(crypto.randomUUID()); }}>Pagar</button>}
                          {r.estado !== "pagado" && <button className="btn btn-danger btn-sm" onClick={() => anularRemito(r)}>Anular</button>}
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}</tbody>
            </table>
          )}
        </div>
      ) : (
      <div className="panel">
        {loading ? <div className="loading">Cargando...</div> : fFilt.length === 0 ? <div className="empty">No hay facturas con esos filtros</div> : (
          <table>
            <thead><tr>
              <th>Proveedor · Nº</th>
              {!localActivo && <th>Local</th>}
              <th>Fecha</th>
              <th>Vencimiento</th>
              <th>Categoría</th>
              <th style={{ textAlign: "right" }}>Total</th>
              <th>Estado</th>
              <th></th>
            </tr></thead>
            <tbody>{fFilt.map(f => {
              const prov = proveedores.find(p => p.id === f.prov_id);
              const isNC = (f.tipo || "factura") === "nota_credito";
              return (
                <tr key={f.id}>
                  <td>
                    <div style={{ fontSize: 12, fontWeight: 500, color: "var(--txt)" }}>{prov?.nombre || "—"}</div>
                    <div style={{ fontSize: 10, color: "var(--muted2)", marginTop: 1, display: "flex", alignItems: "center", gap: 6 }}>
                      <span>{f.nro}</span>
                      {isNC && <span className="badge b-info" style={{ fontSize: 8, letterSpacing: 0.5 }}>NC</span>}
                    </div>
                  </td>
                  {!localActivo && (
                    <td><span className="badge b-muted" style={{ fontSize: 10 }}>{locales.find((l: Local) => l.id === f.local_id)?.nombre || "—"}</span></td>
                  )}
                  <td>
                    <span style={{ fontSize: 11, color: "var(--txt)" }}>{fmt_d(f.fecha)}</span>
                  </td>
                  <td>
                    {f.venc
                      ? <span style={{ fontSize: 11, color: estadoFactura(f) === "vencida" ? "var(--danger)" : "var(--muted2)" }}>{fmt_d(f.venc)}</span>
                      : <span style={{ fontSize: 11, color: "var(--muted)" }}>—</span>}
                  </td>
                  <td><span className="badge b-muted">{f.cat || "—"}</span></td>
                  <td style={{ textAlign: "right" }}><span className="num" style={isNC ? { color: "var(--info)" } : undefined}>{fmt_$(f.total)}</span></td>
                  <td>{isNC
                    ? (() => {
                        if (f.estado === "anulada") return <span className="badge b-muted">NC anulada</span>;
                        const aplicado = (f.pagos || []).reduce((s: number, p: PagoFactura) => s + Number(p.monto || 0), 0);
                        const saldoNc = Math.max(0, Math.abs(Number(f.total || 0)) - aplicado);
                        if (f.estado === "pagada" || saldoNc <= 0) return <span className="badge b-muted">NC consumida</span>;
                        return <span className="badge b-info">NC disponible</span>;
                      })()
                    : estadoDot(estadoFactura(f))}</td>
                  <td>
                    <div style={{ display: "flex", gap: 4, justifyContent: "flex-end" }}>
                      <button className="btn btn-ghost btn-sm" onClick={() => setVerModal(f)}>Ver</button>
                      {!isNC && f.estado !== "pagada" && <button className="btn btn-success btn-sm" onClick={() => { setPagarModal(f); setPagoForm({ cuenta: "", monto: Number(f.total) || 0, fecha: toISO(today) }); setIdempKeyPagarFac(crypto.randomUUID()); }}>Pagar</button>}
                      <button className="btn btn-danger btn-sm" onClick={() => anular(f)}>Anular</button>
                    </div>
                  </td>
                </tr>
              );
            })}</tbody>
          </table>
        )}
      </div>
      )}

      {/* MODAL LECTOR IA */}
      <ModalLectorIA
        abierto={lectorModal} user={user} locales={locales} localActivo={localActivo}
        onClose={() => setLectorModal(false)}
        onSaved={() => { load(); setLectorModal(false); }}
      />

      {/* MODAL CARGAR FACTURA */}
      <ModalCargarFactura
        abierto={modal} onClose={() => setModal(false)}
        form={form} setForm={setForm}
        proveedores={proveedores} localesDisp={localesDisp}
        categorias={{
          compra: CATEGORIAS_COMPRA, fijos: GASTOS_FIJOS, variables: GASTOS_VARIABLES,
          publicidad: GASTOS_PUBLICIDAD, comisiones: COMISIONES_CATS, impuestos: GASTOS_IMPUESTOS,
          bucketMap: categoriaToBucket,
        }}
        onProvChange={onProvChange} calcTotal={calcTotal}
        items={items} addItem={addItem} updateItem={updateItem} removeItem={removeItem}
        guardar={guardar} saving={saving}
      />

      {/* MODAL VER FACTURA */}
      <ModalVerFactura
        factura={verModal} onClose={() => setVerModal(null)}
        proveedores={proveedores} locales={locales}
      />

      {/* MODAL PAGAR */}
      <ModalPagarFactura
        pagarModal={pagarModal} setPagarModal={setPagarModal}
        facturas={facturas}
        ncsAplicar={ncsAplicar} setNcsAplicar={setNcsAplicar}
        pagoForm={pagoForm} setPagoForm={setPagoForm}
        cuentasUsables={cuentasUsables} pagar={pagar} pagando={pagando}
      />

      {/* MODAL CARGAR REMITO — portado de Remitos.tsx (eliminado 2026-05-07) */}
      <ModalCargarRemito
        abierto={remModal} onClose={() => setRemModal(false)}
        form={remForm} setForm={setRemForm}
        proveedores={proveedores} localesDisp={localesDisp}
        categoriasCompra={CATEGORIAS_COMPRA}
        onProvChange={onRemProvChange} guardar={guardarRemito}
      />

      {/* MODAL VINCULAR REMITO A FACTURA */}
      <ModalVincularRemito
        remito={vincModal} onClose={() => setVincModal(null)}
        facturas={facturas} onVincular={vincularRemitoAFactura}
      />

      {/* MODAL PAGAR REMITO DIRECTO */}
      <ModalPagarRemitoDirecto
        remito={pagarRemModal} onClose={() => setPagarRemModal(null)}
        form={remPagoForm} setForm={setRemPagoForm}
        cuentasUsables={cuentasUsables} pagar={pagarRemito} pagando={pagandoRem}
      />
    </div>
  );
}