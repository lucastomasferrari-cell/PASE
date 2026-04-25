import { useState } from "react";
import { db } from "../lib/supabase";
import { toISO, today, fmt_d, fmt_$, genId } from "../lib/utils";
import { useMediosCobro } from "../lib/useMediosCobro";

export default function ImportarMaxirest({ locales, localActivo, onImported }: { locales: any[]; localActivo?: number | null; onImported?: () => void }) {
  const [texto,setTexto]=useState("");
  const [preview,setPreview]=useState(null);
  const [loading,setLoading]=useState(false);
  const { mediosDisponibles, cuentaDestino } = useMediosCobro();

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
    const local_id=Number(localActivo);

    // Catálogo del local activo (globales + específicos). Match contra
    // el catálogo se hace case-insensitive porque Maxirest mete uppercase
    // en el mail pero el catálogo puede tener "Point Nave" mixed case;
    // exigir case-sensitive frustraría al dueño en casos triviales.
    const catalogo=mediosDisponibles(local_id);
    const buscarEnCatalogo=(raw:string)=>{
      const target=raw.trim().toUpperCase();
      return catalogo.find(m=>m.nombre.trim().toUpperCase()===target);
    };

    const ventas:any[]=[];
    const matchedMedios:string[]=[];
    const mediosFaltantes:string[]=[];
    const idx=texto.indexOf("VENTAS POR FORMA DE COBRO");
    if(idx>-1){
      // SUBTOTALES_IGNORAR: filas resumen del mail (no son medios reales).
      // Bug #31: "FORMA DE COBRO" es el header de la sección. "EFECTIVO"
      // se quitó porque ahora es un medio legítimo del catálogo (Belgrano).
      const SUBTOTALES_IGNORAR=["TARJETAS","OTROS","RESUMEN","SUBTOTAL","FORMA DE COBRO"];
      // Regex tolerante a NBSP y comas en el monto.
      const re=/^(.+?)[\s\u00a0]+([\d.,]+)[\s\u00a0]+(\d+)[\s\u00a0]*$/;
      texto.slice(idx).split("\n").forEach(rawLine=>{
        const line=rawLine.replace(/\r/g,"");
        const trimmed=line.trim();
        if(!trimmed){console.log("[maxirest:parse] skip vacío");return;}
        if(/^[~=]+$/.test(trimmed)){console.log("[maxirest:parse] skip separador:",trimmed);return;}
        let mr:string|null=null,montoStr:string|null=null,cantStr:string|null=null;
        const m=line.match(re);
        if(m){
          mr=m[1].trim();montoStr=m[2];cantStr=m[3];
          console.log("[maxirest:parse] match raw='"+trimmed+"' medio='"+mr+"' monto='"+montoStr+"' cant='"+cantStr+"'");
        } else {
          const toks=trimmed.split(/[\s\u00a0]+/);
          if(toks.length>=3 && /^\d+$/.test(toks[toks.length-1]) && /^[\d.,]+$/.test(toks[toks.length-2])){
            cantStr=toks[toks.length-1];montoStr=toks[toks.length-2];
            mr=toks.slice(0,-2).join(" ");
            console.log("[maxirest:parse] fallback split raw='"+trimmed+"' medio='"+mr+"' monto='"+montoStr+"' cant='"+cantStr+"'");
          } else {
            console.log("[maxirest:parse] no-match raw='"+trimmed+"'");
            return;
          }
        }
        const montoNorm=montoStr!.replace(/\.(?=\d{3}(\D|$))/g,"").replace(",",".").replace(/[^\d.]/g,"");
        const monto=parseFloat(montoNorm);
        const cant=parseInt(cantStr!);
        const mrUpper=mr!.toUpperCase();
        // Filtros previos al lookup en catálogo: TOTAL/SUBTOTAL nunca son medios.
        if(monto<=0||mrUpper.includes("TOTAL")||SUBTOTALES_IGNORAR.includes(mrUpper)){
          console.log("[maxirest:parse] descartado por filtro: '"+mr+"'");
          return;
        }
        const matched=buscarEnCatalogo(mr!);
        if(matched){
          ventas.push({medio:matched.nombre,monto,cant,fecha,turno,local_id});
          matchedMedios.push(matched.nombre);
          console.log("[maxirest:parse] catálogo match raw='"+mr+"' → '"+matched.nombre+"' (id "+matched.id+")");
        } else {
          mediosFaltantes.push(mr!);
          console.log("[maxirest:parse] FALTANTE: medio '"+mr+"' no está en el catálogo del local "+local_id);
        }
      });
    }
    console.log("[maxirest:parse] resumen: "+ventas.length+" matcheadas → ["+matchedMedios.join(", ")+"]; "+mediosFaltantes.length+" faltantes → ["+mediosFaltantes.join(", ")+"]");

    // Política dura: si algún medio del cierre no está configurado, NO
    // se importa nada. Un import parcial deja la caja desbalanceada y
    // el dueño no se entera de los faltantes.
    if(mediosFaltantes.length>0){
      const localNombre=locales.find(l=>l.id===local_id)?.nombre||`local #${local_id}`;
      alert(
        "No se pudo importar. Los siguientes medios no están configurados para "+localNombre+":\n\n"+
        mediosFaltantes.map(m=>"  • "+m).join("\n")+
        "\n\nAgregalos en Configuración → Medios de cobro y volvé a intentar."
      );
      setPreview(null);
      return;
    }

    setPreview({fecha,turno,local_id,ventas});
  };
  const confirmar=async()=>{
    if(!preview||preview.ventas.length===0)return;
    if(!localActivo){
      alert("Seleccioná un local en el sidebar antes de importar.");
      return;
    }
    setLoading(true);
    try {
      const lid=Number(localActivo);
      const {data:exist,error:existErr}=await db.from("ventas").select("id").eq("fecha",preview.fecha).eq("turno",preview.turno).eq("local_id",lid).limit(1);
      if(existErr) throw new Error("Error verificando duplicados: "+existErr.message);
      if(exist&&exist.length>0){
        setLoading(false);
        if(!confirm(`⚠ Ya existe un cierre del ${fmt_d(preview.fecha)} turno ${preview.turno} para este local. ¿Importar igual?`))return;
        setLoading(true);
      }

      const ventasAInsertar=preview.ventas.map(v=>({...v,id:genId("V"),local_id:lid,origen:"maxirest"}));
      console.log("[maxirest] Insert ventas: "+ventasAInsertar.length+" filas local_id="+lid);
      const {data:ventasIns,error:ventasErr}=await db.from("ventas").insert(ventasAInsertar).select();
      if(ventasErr) throw new Error("Error insertando ventas: "+ventasErr.message);
      if(!ventasIns||ventasIns.length===0){
        throw new Error("El insert de ventas no devolvió filas — RLS puede estar bloqueando. Verificá permisos sobre el local.");
      }
      if(ventasIns.length<ventasAInsertar.length){
        console.warn("[maxirest] filas insertadas menos que esperadas: "+ventasIns.length+" de "+ventasAInsertar.length);
      }

      // Impacto en cuentas: ahora viene del catálogo dinámico vía hook.
      // Los medios sin cuenta_destino (tarjetas, online, etc) no impactan.
      const impactoPorCuenta:Record<string,number>={};
      ventasAInsertar.forEach(v=>{
        const cuenta=cuentaDestino(v.medio,lid);
        if(!cuenta) return;
        impactoPorCuenta[cuenta]=(impactoPorCuenta[cuenta]||0)+v.monto;
      });
      for(const [cuenta,monto] of Object.entries(impactoPorCuenta)){
        if(!cuenta) continue;
        const {error:movErr}=await db.from("movimientos").insert([{
          id:genId("MOV"),fecha:preview.fecha,cuenta,
          tipo:"Ingreso Venta",cat:"VENTAS",
          importe:monto,detalle:`Ventas ${preview.turno} - ${preview.fecha}`,
          local_id:lid,
        }]);
        if(movErr) console.error("[maxirest] movimiento error (no crítico):",movErr.message);
        const {data:caja}=await db.from("saldos_caja").select("saldo")
          .eq("cuenta",cuenta).eq("local_id",lid).maybeSingle();
        if(caja){
          const {error:saldoErr}=await db.from("saldos_caja")
            .update({saldo:(caja.saldo||0)+monto})
            .eq("cuenta",cuenta).eq("local_id",lid);
          if(saldoErr) console.error("[maxirest] saldo error (no crítico):",saldoErr.message);
        }
      }

      setTexto("");setPreview(null);
      console.log("[maxirest] Import OK: "+ventasIns.length+" filas persistidas, total "+fmt_$(preview.ventas.reduce((s,v)=>s+v.monto,0)));
      alert("✓ Importado: "+ventasIns.length+" registros · Total: "+fmt_$(preview.ventas.reduce((s,v)=>s+v.monto,0)));
      onImported?.();
    } catch (err: any) {
      console.error("[maxirest] confirmar error:",err);
      alert("No se pudo importar: "+err.message);
    } finally {
      setLoading(false);
    }
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
