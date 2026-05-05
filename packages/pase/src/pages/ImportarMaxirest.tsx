import { useState } from "react";
import { db } from "../lib/supabase";
import { toISO, today, fmt_d, fmt_$, genId } from "../lib/utils";
import { useMediosCobro } from "../lib/useMediosCobro";
import type { Local } from "../types";

interface VentaMaxirest {
  medio: string;
  monto: number;
  cant: number;
  fecha: string;
  turno: string;
  local_id: number;
}

interface MaxirestPreview {
  fecha: string;
  turno: string;
  local_id: number;
  ventas: VentaMaxirest[];
}

interface ImportarMaxirestProps {
  locales: Local[];
  localActivo?: number | null;
  onImported?: () => void;
}

type TurnoNombre = "Mediodía" | "Noche";

// Detecta turno con prioridad: campo "Turno: <valor>" → header "Turno N (XXX)"
// → fallback por hora de cierre. La comparación es case/accent-insensitive
// y "Turno 1/2" también mapea como red de seguridad por si el nombre viene
// en idioma o variante no reconocida. Si campo y hora no coinciden, gana
// el campo y queda warning en consola para auditoría.
function detectarTurnoMaxirest(texto: string): TurnoNombre {
  const norm = (s: string): TurnoNombre | null => {
    const x = s.trim().toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
    if (x === "noche") return "Noche";
    if (x === "mediodia") return "Mediodía";
    return null;
  };

  let porCampo: TurnoNombre | null = null;
  let porHeader: TurnoNombre | null = null;
  let porHora: TurnoNombre | null = null;

  const campo = texto.match(/Turno\s*:\s*([A-Za-zÁÉÍÓÚáéíóúñÑ]+)/i);
  if (campo?.[1]) {
    porCampo = norm(campo[1]);
    if (!porCampo) console.warn("[maxirest:turno] valor no reconocido en 'Turno:':", campo[1]);
  }

  // El header acepta paréntesis redondos `(Noche)` (formato Villa Crespo) y
  // corchetes cuadrados `[Noche]` (formato Devoto, reportado 2026-05-08).
  // Maxirest aparentemente alterna según local sin patrón consistente, así
  // que ambos delimitadores son válidos. Si hay otro formato (`{}`, `<>`),
  // agregar acá.
  const header = texto.match(/Turno\s+(\d+)\s*[([]\s*([A-Za-zÁÉÍÓÚáéíóúñÑ]+)/i);
  if (header) {
    const num = parseInt(header[1] || "0", 10);
    porHeader = (header[2] ? norm(header[2]) : null) ?? (num === 1 ? "Mediodía" : num === 2 ? "Noche" : null);
  }

  const cierre = texto.match(/Cierre\s*:\s*(\d{1,2}):(\d{2})/i);
  if (cierre) {
    const h = parseInt(cierre[1] || "0", 10);
    porHora = h < 16 ? "Mediodía" : "Noche";
  }

  const elegido: TurnoNombre = porCampo ?? porHeader ?? porHora ?? "Mediodía";

  if (porCampo && porHora && porCampo !== porHora) {
    console.warn("[maxirest:turno] DISCREPANCIA: campo='" + porCampo + "' vs hora cierre='" + porHora + "' → priorizo campo");
  }
  if (!porCampo && !porHeader && !porHora) {
    console.warn("[maxirest:turno] NO se pudo detectar turno (sin campo, sin header válido, sin hora cierre); default Mediodía");
  }
  console.log("[maxirest:turno] detectado='" + elegido + "' (campo=" + porCampo + ", header=" + porHeader + ", hora=" + porHora + ")");
  return elegido;
}

export default function ImportarMaxirest({ locales, localActivo, onImported }: ImportarMaxirestProps) {
  const [texto,setTexto]=useState("");
  const [preview,setPreview]=useState<MaxirestPreview | null>(null);
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
    if(fm){const ms: Record<string, number>={enero:1,febrero:2,marzo:3,abril:4,mayo:5,junio:6,julio:7,agosto:8,septiembre:9,octubre:10,noviembre:11,diciembre:12};const m=ms[(fm[3]||"").toLowerCase()];if(m)fecha=`${fm[4]}-${String(m).padStart(2,"0")}-${String(fm[2]).padStart(2,"0")}`;}
    const turno=detectarTurnoMaxirest(texto);
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

    const ventas:VentaMaxirest[]=[];
    const matchedMedios:string[]=[];
    const mediosFaltantes:string[]=[];
    const idx=texto.indexOf("VENTAS POR FORMA DE COBRO");
    if(idx>-1){
      // SUBTOTALES_IGNORAR: subtotales del bloque de ventas que no son medios
      // reales (ej: "TARJETAS" = suma de débito + crédito). "FORMA DE COBRO"
      // es el header. "EFECTIVO" no se ignora — ahora es medio legítimo del
      // catálogo (caso Belgrano). Esta lista actúa *dentro* del bloque ventas;
      // el bloque RESUMEN al final del cierre se corta antes con enBloqueVentas.
      const SUBTOTALES_IGNORAR=["TARJETAS","OTROS","RESUMEN","SUBTOTAL","FORMA DE COBRO"];
      // Regex tolerante a NBSP y comas en el monto.
      const re=/^(.+?)[\s\u00a0]+([\d.,]+)[\s\u00a0]+(\d+)[\s\u00a0]*$/;
      // Flag que cierra el bloque VENTAS apenas aparece la línea TOTAL.
      // Sin esto, el bloque RESUMEN al final del cierre (que repite los
      // mismos medios con cant=0 como verificación) se cuela como ventas
      // duplicadas — en Belgrano 24/4 mediodía aparecía "EFECTIVO" 2 veces.
      let enBloqueVentas=true;
      texto.slice(idx).split("\n").forEach(rawLine=>{
        const line=rawLine.replace(/\r/g,"");
        const trimmed=line.trim();
        if(!trimmed){return;}
        if(/^[~=-]+$/.test(trimmed)){return;}
        let mr:string|null=null,montoStr:string|null=null,cantStr:string|null=null;
        const m=line.match(re);
        if(m){
          mr=(m[1]||"").trim();montoStr=m[2]||null;cantStr=m[3]||null;
          if(enBloqueVentas) console.log("[maxirest:parse] match raw='"+trimmed+"' medio='"+mr+"' monto='"+montoStr+"' cant='"+cantStr+"'");
        } else {
          const toks=trimmed.split(/[\s\u00a0]+/);
          if(toks.length>=3 && /^\d+$/.test(toks[toks.length-1]||"") && /^[\d.,]+$/.test(toks[toks.length-2]||"")){
            cantStr=toks[toks.length-1]||null;montoStr=toks[toks.length-2]||null;
            mr=toks.slice(0,-2).join(" ");
            if(enBloqueVentas) console.log("[maxirest:parse] fallback split raw='"+trimmed+"' medio='"+mr+"' monto='"+montoStr+"' cant='"+cantStr+"'");
          } else {
            // Sólo logueo no-match dentro del bloque — fuera del bloque hay
            // mucho ruido de texto libre del cierre que no aporta.
            if(enBloqueVentas) console.log("[maxirest:parse] no-match raw='"+trimmed+"'");
            return;
          }
        }
        const mrUpper=mr!.toUpperCase();
        // Cierre del bloque: línea TOTAL exacta o "TOTAL ..." (ej "TOTAL VENTAS").
        // includes("TOTAL") sería demasiado laxo (matchearía "SUBTOTAL"). Esta
        // línea se skipea Y deja el flag en false para el resto del cierre.
        if(mrUpper==="TOTAL"||mrUpper.startsWith("TOTAL ")){
          console.log("[maxirest:parse] cierre bloque VENTAS en línea TOTAL: '"+trimmed+"'");
          enBloqueVentas=false;
          return;
        }
        if(!enBloqueVentas){
          console.log("[maxirest:parse] skip fuera de bloque ventas: '"+trimmed+"'");
          return;
        }
        const montoNorm=montoStr!.replace(/\.(?=\d{3}(\D|$))/g,"").replace(",",".").replace(/[^\d.]/g,"");
        const monto=parseFloat(montoNorm);
        const cant=parseInt(cantStr!);
        // Defensa en profundidad: cant<=0 cubre el caso edge donde una fila
        // de RESUMEN se colara antes del TOTAL. Con el flag bien puesto no
        // debería pasar, pero no quiero depender solo de la detección de TOTAL.
        if(monto<=0||cant<=0||SUBTOTALES_IGNORAR.includes(mrUpper)){
          console.log("[maxirest:parse] descartado por filtro: '"+mr+"' monto="+monto+" cant="+cant);
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
      const localNombre=locales.find((l: Local)=>l.id===local_id)?.nombre||`local #${local_id}`;
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

      const ventasAInsertar=preview.ventas.map((v: VentaMaxirest)=>({...v,id:genId("V"),local_id:lid,origen:"maxirest"}));
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
      // venta_ids linkea cada movimiento con sus ventas para que las RPCs
      // eliminar_venta/editar_venta puedan ajustarlo atómicamente.
      const impactoPorCuenta:Record<string,number>={};
      const idsPorCuenta:Record<string,string[]>={};
      ((ventasIns||[]) as { id: string; medio: string; monto: number }[]).forEach(v=>{
        const cuenta=cuentaDestino(v.medio,lid);
        if(!cuenta) return;
        impactoPorCuenta[cuenta]=(impactoPorCuenta[cuenta]||0)+v.monto;
        (idsPorCuenta[cuenta]=idsPorCuenta[cuenta]||[]).push(v.id);
      });
      for(const [cuenta,monto] of Object.entries(impactoPorCuenta)){
        if(!cuenta) continue;
        const {error:movErr}=await db.from("movimientos").insert([{
          id:genId("MOV"),fecha:preview.fecha,cuenta,
          tipo:"Ingreso Venta",cat:"VENTAS",
          importe:monto,detalle:`Ventas ${preview.turno} - ${preview.fecha}`,
          local_id:lid,
          venta_ids:idsPorCuenta[cuenta]||[],
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
      console.log("[maxirest] Import OK: "+ventasIns.length+" filas persistidas, total "+fmt_$(preview.ventas.reduce((s: number,v: VentaMaxirest)=>s+v.monto,0)));
      alert("✓ Importado: "+ventasIns.length+" registros · Total: "+fmt_$(preview.ventas.reduce((s: number,v: VentaMaxirest)=>s+v.monto,0)));
      onImported?.();
    } catch (err) {
      console.error("[maxirest] confirmar error:",err);
      alert("No se pudo importar: " + (err instanceof Error ? err.message : String(err)));
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
          <div className="panel-hd"><span className="panel-title">Preview — {fmt_d(preview.fecha)} · {preview.turno} · {locales.find((l: Local)=>l.id===preview.local_id)?.nombre}</span></div>
          <div style={{padding:16}}>
            {preview.ventas.length>0?(
              <>
                <table style={{marginBottom:12}}><thead><tr><th>Forma de Cobro</th><th>Monto</th><th>Cant.</th></tr></thead>
                <tbody>{preview.ventas.map((v: VentaMaxirest,i: number)=><tr key={i}><td>{v.medio}</td><td><span className="num kpi-success">{fmt_$(v.monto)}</span></td><td style={{color:"var(--muted2)"}}>{v.cant}</td></tr>)}</tbody></table>
                <div style={{fontFamily:"'Inter',sans-serif",fontSize:17,fontWeight:500,color:"var(--success)",marginBottom:16}}>Total: {fmt_$(preview.ventas.reduce((s: number,v: VentaMaxirest)=>s+v.monto,0))}</div>
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