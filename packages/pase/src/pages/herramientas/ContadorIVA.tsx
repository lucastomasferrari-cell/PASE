import { useState, useEffect } from "react";
import { db } from "../../lib/supabase";
import { applyLocalScope } from "../../lib/auth";
import { toISO, fmt_d, fmt_$ } from "@pase/shared/utils";
import { today } from "../../lib/utils";
import { InfoTooltip } from "../../components/ui";
import type { Usuario, Local } from "../../types/auth";
import type { Factura, Venta } from "../../types/finanzas";

interface ContadorProps {
  user: Usuario;
  locales: Local[];
  localActivo: number | null;
}

// Columnas del Libro IVA Compras (Lucas 10-jun: discriminación fiscal AR
// completa que pide el contador). Si una columna está toda en 0 para el
// mes seleccionado, se oculta del listado/CSV para no saturar la vista —
// pero los datos quedan en la DB y aparecen apenas haya una factura que
// la use. CSV usa todas las columnas siempre, para que el export sea
// consistente entre meses.
type FacturaIVACol = {
  key: keyof Factura;
  label: string;
  /** Si el contador necesita verlas siempre, marcar con alwaysShow. */
  alwaysShow?: boolean;
  /** Color para el cell — celeste para neto, amarillo para IVA, gris para
   *  percepciones, naranja para retenciones. */
  color?: string;
};
const COLUMNAS_IVA: FacturaIVACol[] = [
  { key: "neto", label: "Neto Gravado", alwaysShow: true },
  { key: "no_gravado", label: "No Gravado" },
  { key: "exento", label: "Exento" },
  { key: "iva21", label: "IVA 21%", alwaysShow: true, color: "var(--warn)" },
  { key: "iva105", label: "IVA 10.5%", alwaysShow: true, color: "var(--warn)" },
  { key: "iva27", label: "IVA 27%", color: "var(--warn)" },
  { key: "perc_iva", label: "Perc. IVA", color: "var(--muted2)" },
  { key: "iibb_caba", label: "IIBB CABA", color: "var(--muted2)" },
  { key: "iibb_ba", label: "IIBB Bs As", color: "var(--muted2)" },
  { key: "iibb_otros", label: "IIBB Otros", color: "var(--muted2)" },
  { key: "perc_ganancias", label: "Perc. Gan.", color: "#d97706" },
  { key: "retencion_suss", label: "Ret. SUSS", color: "#d97706" },
  { key: "otros_cargos", label: "Imp. Internos / Otros", color: "var(--muted2)" },
  { key: "descuentos", label: "Descuentos", color: "var(--success)" },
];

export default function Contador({ user, locales, localActivo }: ContadorProps) {
  const [facturas,setFacturas]=useState<Factura[]>([]);
  const [ventas,setVentas]=useState<Venta[]>([]);
  const [loading,setLoading]=useState(true);
  const [tab,setTab]=useState("iva");
  const [mes,setMes]=useState(toISO(today).slice(0,7));
  useEffect(()=>{
    const load=async()=>{
      setLoading(true);
      const [cyr,cmo]=mes.split("-").map(Number) as [number, number]; const desde=mes+"-01",hasta=mes+"-"+String(new Date(cyr,cmo,0).getDate()).padStart(2,"0");
      // Egress fix 2026-05-28: SELECT * → columnas específicas.
      // 10-jun: agregadas las 9 columnas de discriminación fiscal AR
      // (iva27 / no_gravado / exento / iibb_caba/ba/otros + jurisdicción /
      // perc_ganancias / retencion_suss). Migración 202606102300.
      let fq = db.from("facturas").select(`
        id, fecha, nro, iva21, iva105, iva27, neto, no_gravado, exento, iibb,
        iibb_caba, iibb_ba, iibb_otros, iibb_otros_jurisdiccion,
        perc_iva, perc_ganancias, retencion_suss,
        otros_cargos, descuentos, total, estado, local_id, prov_id
      `).gte("fecha",desde).lte("fecha",hasta).neq("estado","anulada");
      fq = applyLocalScope(fq, user, localActivo);
      let vq = db.from("ventas").select("id, fecha, monto, local_id").gte("fecha",desde).lte("fecha",hasta);
      vq = applyLocalScope(vq, user, localActivo);
      const [{data:f},{data:v}]=await Promise.all([fq, vq]);
      setFacturas((f as Factura[]) || []);
      setVentas((v as Venta[]) || []);
      setLoading(false);
    };
    load();
  // user no cambia durante el lifecycle del componente (App lo desmonta
  // en logout, lo remonta en login con user ya seteado). Agregarlo a deps
  // sería ruido sin cambio funcional.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[mes,localActivo]);

  // KPIs IVA
  const ivaC21=facturas.reduce((s, f) => s + (f.iva21 || 0), 0);
  const ivaC105=facturas.reduce((s, f) => s + (f.iva105 || 0), 0);
  const ivaC27=facturas.reduce((s, f) => s + (f.iva27 || 0), 0);
  const totalIvaC=ivaC21+ivaC105+ivaC27;
  const totalV=ventas.reduce((s, v) => s + (v.monto || 0), 0);
  const ivaV=totalV/1.21*0.21;
  const pos=ivaV-totalIvaC;

  // Solo mostramos columnas con al menos una factura > 0 (más las always-show).
  // Esto evita que un mes simple muestre 14 columnas vacías.
  const columnasVisibles = COLUMNAS_IVA.filter(c =>
    c.alwaysShow || facturas.some(f => Number(f[c.key] || 0) > 0)
  );

  // Totales por columna para el footer del listado.
  const totalesPorCol: Record<string, number> = {};
  for (const c of COLUMNAS_IVA) {
    totalesPorCol[c.key as string] = facturas.reduce((s, f) => s + Number(f[c.key] || 0), 0);
  }
  const totalFacturado = facturas.reduce((s, f) => s + Number(f.total || 0), 0);

  // CSV export: usa SIEMPRE todas las columnas (consistencia mes a mes
  // para el contador). + jurisdicción del IIBB otros como columna texto.
  const exportCSV = () => {
    const headers = [
      "Fecha","Nº Factura",
      ...COLUMNAS_IVA.map(c => c.label),
      "IIBB Jurisdicción (otros)","Total",
    ];
    const rows = facturas.map(f => [
      f.fecha, f.nro,
      ...COLUMNAS_IVA.map(c => Number(f[c.key] || 0).toFixed(2)),
      f.iibb_otros_jurisdiccion || "",
      Number(f.total || 0).toFixed(2),
    ]);
    // Línea de totales al final.
    const totalsRow = [
      "TOTAL","",
      ...COLUMNAS_IVA.map(c => Number(totalesPorCol[c.key as string] || 0).toFixed(2)),
      "", totalFacturado.toFixed(2),
    ];
    const csv = [headers, ...rows, totalsRow].map(r => r.map(s => {
      const str = String(s);
      // Encerrar entre comillas si contiene coma o comillas
      return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
    }).join(",")).join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8;" }));
    a.download = `libro_compras_${mes}.csv`;
    a.click();
  };
  const exportVentasCSV = () => {
    const rows = [["Fecha","Local","Forma Cobro","Total","Neto Est","IVA 21 Est"]];
    for (const v of ventas) {
      rows.push([
        v.fecha,
        locales.find(l => String(l.id) === String(v.local_id))?.nombre || "",
        v.medio,
        String(v.monto),
        (v.monto / 1.21).toFixed(2),
        (v.monto / 1.21 * 0.21).toFixed(2),
      ]);
    }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([rows.map(r => r.join(",")).join("\n")], { type: "text/csv" }));
    a.download = `libro_ventas_${mes}.csv`;
    a.click();
  };

  return (
    <div>
      <div className="ph-row">
        <div style={{display:"flex",alignItems:"center",gap:6}}>
          <div className="ph-title">Contador / IVA</div>
          <InfoTooltip maxWidth={320}>
            Libro IVA Compras con discriminación completa (IVA 21/10.5/27, no gravado, exento,
            percepciones IIBB por jurisdicción CABA/Bs As/otros, perc. Ganancias y SUSS, imp. internos).
            Si un mes no usa una columna, se oculta del listado pero queda en el CSV exportado.
          </InfoTooltip>
        </div>
        <input type="month" className="search" style={{width:160}} value={mes} onChange={e=>setMes(e.target.value)}/>
      </div>
      <div className="tabs">
        {([["iva","Monitor IVA"],["compras","Libro IVA Compras"],["ventas_l","Libro IVA Ventas"]] as [string, string][]).map(([id,l])=>(
          <div key={id} className={`tab ${tab===id?"active":""}`} onClick={()=>setTab(id)}>{l}</div>
        ))}
      </div>
      {loading?<div className="loading">Cargando...</div>:tab==="iva"?(
        <>
          <div className="grid3">
            <div className="kpi kpi-sm"><div className="kpi-label">IVA Ventas (Débito)</div><div className="kpi-value-compact kpi-danger">{fmt_$(ivaV)}</div><div className="kpi-sub">Estimado s/ {fmt_$(totalV)}</div></div>
            <div className="kpi kpi-sm"><div className="kpi-label">IVA Compras (Crédito)</div><div className="kpi-value-compact kpi-success">{fmt_$(totalIvaC)}</div><div className="kpi-sub">21%: {fmt_$(ivaC21)} · 10.5%: {fmt_$(ivaC105)}{ivaC27 > 0 ? ` · 27%: ${fmt_$(ivaC27)}` : ""}</div></div>
            <div className="kpi kpi-sm"><div className="kpi-label">Posición Neta</div><div className={`kpi-value-compact ${pos>0?"kpi-danger":"kpi-success"}`}>{fmt_$(pos)}</div><div className="kpi-sub">{pos>0?"⚠ A pagar a AFIP":"✓ Saldo a favor"}</div></div>
          </div>
          <div className="panel">
            <div className="panel-hd"><span className="panel-title">Resumen Fiscal — {mes}</span></div>
            <div style={{padding:"8px 0 12px"}}>
              {([["Débito Fiscal (IVA ventas)",ivaV,"var(--danger)"],["(-) Crédito Fiscal",-totalIvaC,"var(--success)"],["(=) Posición Neta",pos,pos>0?"var(--danger)":"var(--success)"]] as [string, number, string][]).map(([l,v,c],i)=>(
                <div key={i} className="eerr-row" style={i===2?{background:"var(--s2)",padding:"12px 16px"}:{}}>
                  <span style={{fontSize:i===2?13:12,fontWeight:i===2?600:400}}>{l}</span>
                  <span style={{fontFamily:"'Inter',sans-serif",fontSize:i===2?17:14,fontWeight:500,color:c}}>{fmt_$(v)}</span>
                </div>
              ))}
              <div style={{margin:"12px 16px 0",padding:"10px 12px",background:pos>50000?"rgba(239,68,68,.08)":"rgba(34,197,94,.08)",border:`1px solid ${pos>50000?"rgba(239,68,68,.3)":"rgba(34,197,94,.3)"}`,borderRadius:"var(--r)",fontSize:11}}>
                {pos>50000?"⚠ Posición IVA elevada. Considerá hacer más compras con factura.":"✓ Posición IVA bajo control."}
              </div>
            </div>
          </div>
        </>
      ):tab==="compras"?(
        <div className="panel">
          <div className="panel-hd">
            <span className="panel-title">Libro IVA Compras — {mes} ({facturas.length} comp.)</span>
            <button className="btn btn-acc btn-sm" onClick={exportCSV}>⬇ Exportar CSV (todas las columnas)</button>
          </div>
          {facturas.length===0?<div className="empty">Sin facturas</div>:(
            <div style={{ overflowX: "auto" }}>
              <table style={{ minWidth: "fit-content" }}>
                <thead>
                  <tr>
                    <th>Fecha</th>
                    <th>Nº Factura</th>
                    {columnasVisibles.map(c => <th key={c.key as string}>{c.label}</th>)}
                    <th>Total</th>
                  </tr>
                </thead>
                <tbody>
                  {facturas.map(f => (
                    <tr key={f.id}>
                      <td className="mono">{fmt_d(f.fecha)}</td>
                      <td className="mono">{f.nro}</td>
                      {columnasVisibles.map(c => {
                        const v = Number(f[c.key] || 0);
                        return (
                          <td key={c.key as string} style={{ color: v > 0 ? (c.color || undefined) : "var(--muted)", textAlign: "right" }}>
                            {v > 0 ? fmt_$(v) : "—"}
                          </td>
                        );
                      })}
                      <td><span className="num kpi-acc">{fmt_$(f.total)}</span></td>
                    </tr>
                  ))}
                </tbody>
                <tfoot style={{ background: "var(--s2)", borderTop: "0.5px solid var(--bd)", fontWeight: 500 }}>
                  <tr>
                    <td colSpan={2} style={{ textAlign: "right", padding: "8px 6px" }}>TOTAL</td>
                    {columnasVisibles.map(c => (
                      <td key={c.key as string} style={{ color: c.color || undefined, textAlign: "right" }}>
                        {fmt_$(totalesPorCol[c.key as string] || 0)}
                      </td>
                    ))}
                    <td style={{ textAlign: "right" }}><span className="num kpi-acc">{fmt_$(totalFacturado)}</span></td>
                  </tr>
                </tfoot>
              </table>
              <div style={{ marginTop: 10, fontSize: 11, color: "var(--muted2)" }}>
                Las columnas con todos los valores en 0 para el mes se ocultan acá pero
                <strong> sí aparecen en el CSV exportado</strong> (vacías), para que el
                contador tenga siempre el mismo formato de planilla.
              </div>
            </div>
          )}
        </div>
      ):(
        <div className="panel">
          <div className="panel-hd">
            <span className="panel-title">Libro IVA Ventas — {mes} ({ventas.length} reg.)</span>
            <button className="btn btn-acc btn-sm" onClick={exportVentasCSV}>⬇ Exportar CSV</button>
          </div>
          {ventas.length===0?<div className="empty">Sin ventas</div>:(
            <table><thead><tr><th>Fecha</th><th>Local</th><th>Forma de Cobro</th><th>Total</th><th>Neto Est.</th><th>IVA Est.</th></tr></thead>
            <tbody>{ventas.map(v => <tr key={v.id}><td className="mono">{fmt_d(v.fecha)}</td><td style={{fontSize:11,color:"var(--muted2)"}}>{locales.find(l => String(l.id) === String(v.local_id))?.nombre}</td><td>{v.medio}</td><td><span className="num kpi-success">{fmt_$(v.monto)}</span></td><td style={{color:"var(--muted2)"}}>{fmt_$(v.monto/1.21)}</td><td style={{color:"var(--warn)"}}>{fmt_$(v.monto/1.21*0.21)}</td></tr>)}</tbody>
          </table>)}
        </div>
      )}
    </div>
  );
}
