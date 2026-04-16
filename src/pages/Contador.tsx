import { useState, useEffect } from "react";
import { db } from "../lib/supabase";
import { toISO, today, fmt_d, fmt_$ } from "../lib/utils";

export default function Contador({ locales, localActivo }) {
  const [facturas,setFacturas]=useState([]);
  const [ventas,setVentas]=useState([]);
  const [loading,setLoading]=useState(true);
  const [tab,setTab]=useState("iva");
  const [mes,setMes]=useState(toISO(today).slice(0,7));
  useEffect(()=>{
    const load=async()=>{
      setLoading(true);
      const [cyr,cmo]=mes.split("-").map(Number); const desde=mes+"-01",hasta=mes+"-"+String(new Date(cyr,cmo,0).getDate()).padStart(2,"0");
      const [{data:f},{data:v}]=await Promise.all([
        db.from("facturas").select("*").gte("fecha",desde).lte("fecha",hasta).neq("estado","anulada"),
        db.from("ventas").select("*").gte("fecha",desde).lte("fecha",hasta),
      ]);
      const lid=localActivo?parseInt(localActivo):null;
      setFacturas((f||[]).filter(x=>!lid||parseInt(x.local_id)===lid));
      setVentas((v||[]).filter(x=>!lid||parseInt(x.local_id)===lid));
      setLoading(false);
    };
    load();
  },[mes,localActivo]);
  const ivaC21=facturas.reduce((s,f)=>s+(f.iva21||0),0);
  const ivaC105=facturas.reduce((s,f)=>s+(f.iva105||0),0);
  const totalIvaC=ivaC21+ivaC105;
  const totalV=ventas.reduce((s,v)=>s+(v.monto||0),0);
  const ivaV=totalV/1.21*0.21;
  const pos=ivaV-totalIvaC;
  const exportCSV=(rows,fn)=>{const a=document.createElement("a");a.href=URL.createObjectURL(new Blob([rows.map(r=>r.join(",")).join("\n")],{type:"text/csv"}));a.download=fn;a.click();};
  return (
    <div>
      <div className="ph-row">
        <div><div className="ph-title">Contador / IVA</div></div>
        <input type="month" className="search" style={{width:160}} value={mes} onChange={e=>setMes(e.target.value)}/>
      </div>
      <div className="tabs">
        {[["iva","Monitor IVA"],["compras","Libro IVA Compras"],["ventas_l","Libro IVA Ventas"]].map(([id,l])=>(
          <div key={id} className={`tab ${tab===id?"active":""}`} onClick={()=>setTab(id)}>{l}</div>
        ))}
      </div>
      {loading?<div className="loading">Cargando...</div>:tab==="iva"?(
        <>
          <div className="grid3">
            <div className="kpi"><div className="kpi-label">IVA Ventas (Débito)</div><div className="kpi-value kpi-danger">{fmt_$(ivaV)}</div><div className="kpi-sub">Estimado s/ {fmt_$(totalV)}</div></div>
            <div className="kpi"><div className="kpi-label">IVA Compras (Crédito)</div><div className="kpi-value kpi-success">{fmt_$(totalIvaC)}</div><div className="kpi-sub">21%: {fmt_$(ivaC21)} · 10.5%: {fmt_$(ivaC105)}</div></div>
            <div className="kpi"><div className="kpi-label">Posición Neta</div><div className={`kpi-value ${pos>0?"kpi-danger":"kpi-success"}`}>{fmt_$(pos)}</div><div className="kpi-sub">{pos>0?"⚠ A pagar a AFIP":"✓ Saldo a favor"}</div></div>
          </div>
          <div className="panel">
            <div className="panel-hd"><span className="panel-title">Resumen Fiscal — {mes}</span></div>
            <div style={{padding:"8px 0 12px"}}>
              {[["Débito Fiscal (IVA ventas)",ivaV,"var(--danger)"],["(-) Crédito Fiscal",-totalIvaC,"var(--success)"],["(=) Posición Neta",pos,pos>0?"var(--danger)":"var(--success)"]].map(([l,v,c],i)=>(
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
            <button className="btn btn-acc btn-sm" onClick={()=>exportCSV([["Fecha","Nro Factura","Neto","IVA 21","IVA 10.5","IIBB","Total"],...facturas.map(f=>[f.fecha,f.nro,f.neto,f.iva21,f.iva105,f.iibb,f.total])],`libro_compras_${mes}.csv`)}>⬇ Exportar CSV</button>
          </div>
          {facturas.length===0?<div className="empty">Sin facturas</div>:(
            <table><thead><tr><th>Fecha</th><th>Nº Factura</th><th>Neto</th><th>IVA 21%</th><th>IVA 10.5%</th><th>IIBB</th><th>Total</th></tr></thead>
            <tbody>{facturas.map(f=><tr key={f.id}><td className="mono">{fmt_d(f.fecha)}</td><td className="mono">{f.nro}</td><td>{fmt_$(f.neto)}</td><td style={{color:"var(--warn)"}}>{fmt_$(f.iva21)}</td><td style={{color:"var(--warn)"}}>{fmt_$(f.iva105)}</td><td style={{color:"var(--muted2)"}}>{fmt_$(f.iibb)}</td><td><span className="num kpi-acc">{fmt_$(f.total)}</span></td></tr>)}</tbody>
          </table>)}
        </div>
      ):(
        <div className="panel">
          <div className="panel-hd">
            <span className="panel-title">Libro IVA Ventas — {mes} ({ventas.length} reg.)</span>
            <button className="btn btn-acc btn-sm" onClick={()=>exportCSV([["Fecha","Local","Forma Cobro","Total","Neto Est","IVA 21 Est"],...ventas.map(v=>[v.fecha,locales.find(l=>l.id===v.local_id)?.nombre,v.medio,v.monto,(v.monto/1.21).toFixed(2),(v.monto/1.21*0.21).toFixed(2)])],`libro_ventas_${mes}.csv`)}>⬇ Exportar CSV</button>
          </div>
          {ventas.length===0?<div className="empty">Sin ventas</div>:(
            <table><thead><tr><th>Fecha</th><th>Local</th><th>Forma de Cobro</th><th>Total</th><th>Neto Est.</th><th>IVA Est.</th></tr></thead>
            <tbody>{ventas.map(v=><tr key={v.id}><td className="mono">{fmt_d(v.fecha)}</td><td style={{fontSize:11,color:"var(--muted2)"}}>{locales.find(l=>l.id===v.local_id)?.nombre}</td><td>{v.medio}</td><td><span className="num kpi-success">{fmt_$(v.monto)}</span></td><td style={{color:"var(--muted2)"}}>{fmt_$(v.monto/1.21)}</td><td style={{color:"var(--warn)"}}>{fmt_$(v.monto/1.21*0.21)}</td></tr>)}</tbody>
          </table>)}
        </div>
      )}
    </div>
  );
}
