import { useState } from "react";
import { db } from "../lib/supabase";
import { toISO, today, fmt_d, fmt_$, genId } from "../lib/utils";
import { MEDIOS_COBRO, MEDIO_A_CUENTA } from "../lib/constants";

export default function ImportarMaxirest({ locales, localActivo, onImported }: { locales: any[]; localActivo?: number | null; onImported?: () => void }) {
  const [texto,setTexto]=useState("");
  const [preview,setPreview]=useState(null);
  const [loading,setLoading]=useState(false);
  const MMAP={"EFECTIVO SALON":"EFECTIVO SALON","EFECTIVO DELIVERY":"EFECTIVO DELIVERY","TARJETA DEBITO":"TARJETA DEBITO","TARJETA CREDITO":"TARJETA CREDITO","RAPPI ONLINE":"RAPPI ONLINE","PEYA ONLINE":"PEYA ONLINE","MP DELIVERY":"MP DELIVERY","MASDELIVERY ONLINE":"MASDELIVERY ONLINE","BIGBOX":"BIGBOX","FANBAG":"FANBAG","TRANSFERENCIA":"TRANSFERENCIA","QR":"QR","LINK":"LINK","POINT NAVE":"Point Nave"};
  const parsear=()=>{
    if(!texto.trim())return;
    if(!localActivo){
      alert("Seleccioná un local en el sidebar antes de importar. El cierre se asignará SIEMPRE al local activo, nunca al que figura en el CSV.");
      return;
    }
    let fecha=toISO(today);
    const fm=texto.match(/(\w+)\s+(\d+)\s+de\s+(\w+)\s+de\s+(\d{4})/i);
    if(fm){const ms={enero:1,febrero:2,marzo:3,abril:4,mayo:5,junio:6,julio:7,agosto:8,septiembre:9,octubre:10,noviembre:11,diciembre:12};const m=ms[fm[3].toLowerCase()];if(m)fecha=`${fm[4]}-${String(m).padStart(2,"0")}-${String(fm[2]).padStart(2,"0")}`;}
    const tm=texto.match(/Turno\s+\d+\s+\((\w+)/i);
    const turno=tm?.[1]==="Noche"?"Noche":"Mediodía";
    // local_id viene SIEMPRE del sidebar (localActivo), nunca del CSV.
    // El CSV de Maxirest puede venir del local equivocado — no lo usamos.
    const local_id=Number(localActivo);
    const ventas=[];
    const idx=texto.indexOf("VENTAS POR FORMA DE COBRO");
    if(idx>-1){
      texto.slice(idx).split("\n").forEach(line=>{
        const m=line.match(/^(.+?)\s+([\d.]+)\s+(\d+)\s*$/);
        if(m){const mr=m[1].trim().toUpperCase();const monto=parseFloat(m[2]);const cant=parseInt(m[3]);const SUBTOTALES_IGNORAR=["EFECTIVO","TARJETAS","OTROS","RESUMEN","SUBTOTAL"];if(monto>0&&!mr.includes("TOTAL")&&!mr.includes("OTROS")&&!SUBTOTALES_IGNORAR.includes(mr)){ventas.push({medio:MMAP[mr]||mr,monto,cant,fecha,turno,local_id});}}
      });
    }
    setPreview({fecha,turno,local_id,ventas});
  };
  const confirmar=async()=>{
    if(!preview||preview.ventas.length===0)return;
    setLoading(true);
    // Check for duplicate: same fecha + turno + local
    const {data:exist}=await db.from("ventas").select("id").eq("fecha",preview.fecha).eq("turno",preview.turno).eq("local_id",parseInt(preview.local_id)).limit(1);
    if(exist&&exist.length>0){
      setLoading(false);
      if(!confirm(`⚠ Ya existe un cierre del ${fmt_d(preview.fecha)} turno ${preview.turno} para este local. ¿Importar igual?`))return;
      setLoading(true);
    }
    const lid=parseInt(preview.local_id);
    const ventasAInsertar=preview.ventas.map(v=>({...v,id:genId("V"),local_id:lid,origen:"maxirest"}));
    await db.from("ventas").insert(ventasAInsertar);

    const impactoPorCuenta:Record<string,number>={};
    ventasAInsertar.forEach(v=>{
      const cuenta=MEDIO_A_CUENTA[v.medio];
      if(!cuenta) return; // medios no-efectivo no impactan en caja
      impactoPorCuenta[cuenta]=(impactoPorCuenta[cuenta]||0)+v.monto;
    });
    for(const [cuenta,monto] of Object.entries(impactoPorCuenta)){
      if(!cuenta) continue;
      await db.from("movimientos").insert([{
        id:genId("MOV"),fecha:preview.fecha,cuenta,
        tipo:"Ingreso Venta",cat:"VENTAS",
        importe:monto,detalle:`Ventas ${preview.turno} - ${preview.fecha}`,
        local_id:lid,
      }]);
      const {data:caja}=await db.from("saldos_caja").select("saldo")
        .eq("cuenta",cuenta).eq("local_id",lid).maybeSingle();
      if(caja) await db.from("saldos_caja")
        .update({saldo:(caja.saldo||0)+monto})
        .eq("cuenta",cuenta).eq("local_id",lid);
    }

    setLoading(false);setTexto("");setPreview(null);
    alert("✓ Importado: "+preview.ventas.length+" registros · Total: "+fmt_$(preview.ventas.reduce((s,v)=>s+v.monto,0)));
    onImported?.();
  };
  return (
    <div>
      <div className="ph-row"><div><div className="ph-title">Importar Maxirest</div></div></div>
      <div className="panel">
        <div className="panel-hd"><span className="panel-title">Texto del mail de cierre</span></div>
        <div style={{padding:16}}>
          <textarea style={{width:"100%",height:280,background:"var(--bg)",border:"1px solid var(--bd)",color:"var(--txt)",padding:"10px 12px",fontFamily:"'DM Mono',monospace",fontSize:11,borderRadius:"var(--r)",outline:"none",resize:"vertical"}} placeholder="Pegá acá el texto completo del mail de cierre de Maxirest..." value={texto} onChange={e=>setTexto(e.target.value)}/>
          <button className="btn btn-acc" style={{marginTop:8}} onClick={parsear}>Analizar texto</button>
        </div>
      </div>
      {preview&&(
        <div className="panel">
          <div className="panel-hd"><span className="panel-title">Preview — {fmt_d(preview.fecha)} · {preview.turno} · {locales.find(l=>l.id===preview.local_id)?.nombre}</span></div>
          <div style={{padding:16}}>
            {preview.ventas.length>0?(
              <>
                <table style={{marginBottom:12}}><thead><tr><th>Forma de Cobro</th><th>Monto</th><th>Cant.</th></tr></thead>
                <tbody>{preview.ventas.map((v,i)=><tr key={i}><td>{v.medio}</td><td><span className="num kpi-success">{fmt_$(v.monto)}</span></td><td style={{color:"var(--muted2)"}}>{v.cant}</td></tr>)}</tbody></table>
                <div style={{fontFamily:"'Inter',sans-serif",fontSize:17,fontWeight:500,color:"var(--success)",marginBottom:16}}>Total: {fmt_$(preview.ventas.reduce((s,v)=>s+v.monto,0))}</div>
              </>
            ):<div className="alert alert-warn">No se detectaron ventas. Verificá el formato.</div>}
            <div style={{display:"flex",gap:8}}>
              <button className="btn btn-sec" onClick={()=>setPreview(null)}>Cancelar</button>
              <button className="btn btn-acc" onClick={confirmar} disabled={loading||preview.ventas.length===0}>{loading?"Importando...":"✓ Confirmar e Importar"}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
