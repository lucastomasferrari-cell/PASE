import { useState, useEffect } from "react";
import { db } from "../lib/supabase";
import { fmt_d, fmt_$, genId, parseMonto } from "../lib/utils";
import { useCategorias } from "../lib/useCategorias";
import { UNIDADES } from "../lib/constants";

export default function LectorFacturasIA({ locales, localActivo }) {
  const { CATEGORIAS_COMPRA } = useCategorias();
  const [archivo,setArchivo]=useState<File|null>(null);
  const [preview,setPreview]=useState<string|null>(null);
  const [loading,setLoading]=useState(false);
  const [resultado,setResultado]=useState(null);
  const [proveedores,setProveedores]=useState([]);
  const [insumos,setInsumos]=useState([]);
  const [guardando,setGuardando]=useState(false);
  const [form,setForm]=useState({local_id:localActivo||"",prov_id:"",fecha:"",venc:"",nro:"",neto:0,iva21:0,iva105:0,iibb:0,total:0,cat:""});
  // Modal inline para crear un proveedor nuevo cuando el emisor detectado
  // por IA no matchea con ninguno existente.
  const [provModal,setProvModal]=useState<any>(null); // null | {nombre, cuit, cat}
  const [provSaving,setProvSaving]=useState(false);

  useEffect(()=>{
    Promise.all([
      db.from("proveedores").select("*").eq("estado","Activo").order("nombre"),
      db.from("insumos").select("*").eq("activo",true).order("nombre"),
    ]).then(([{data:p},{data:i}])=>{setProveedores(p||[]);setInsumos(i||[]);});
  },[]);

  const toBase64=file=>new Promise((res,rej)=>{
    const r=new FileReader();
    r.onload=()=>res(r.result.split(",")[1]);
    r.onerror=()=>rej(new Error("Error al leer"));
    r.readAsDataURL(file);
  });

  const leerConIA=async()=>{
    if(!archivo)return;
    setLoading(true);setResultado(null);
    try{
      const base64=await toBase64(archivo);
      const isImg=archivo.type.startsWith("image/");
      const mediaType=isImg?archivo.type:"application/pdf";

      const response=await fetch("/api/claude",{
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({
          // Bug #41 fase final, Capa 2: Opus 4.7 tiene 98.5% en visual-acuity
          // benchmark vs ~54% de Sonnet 4 — específicamente bueno para
          // extracción visual de documentos con tipografías chicas como las
          // facturas argentinas. El proxy api/claude.js es transparente
          // y reenvía cualquier model que mandemos.
          model:"claude-opus-4-7",
          max_tokens:1500,
          messages:[{
            role:"user",
            content:[
              {type:isImg?"image":"document",source:{type:"base64",media_type:mediaType,data:base64}},
              {type:"text",text:`Extraé datos de esta factura argentina. Devolvé SOLO JSON, sin texto extra, sin markdown.

FORMATO CRÍTICO DE MONTOS:
En Argentina: punto = miles, coma = decimal. Ejemplo: "166.876,67" = ciento sesenta y seis mil ochocientos setenta y seis con sesenta y siete centavos.
En el JSON, usá punto decimal: 166876.67. NUNCA elimines la coma decimal — eso multiplica por 100 y rompe la factura.

Si hay dudas sobre un monto, devolvé 0 y bajá la confianza, NUNCA inventes números.

Estructura JSON requerida:
{
  "razon_social": "string",
  "cuit_emisor": "XX-XXXXXXXX-X",
  "tipo_factura": "A|B|C|X",
  "nro_factura": "XXXX-XXXXXXXX",
  "fecha_emision": "YYYY-MM-DD",
  "fecha_vencimiento": "YYYY-MM-DD o null",
  "neto_gravado": numero_o_0,
  "iva_21": numero_o_0,
  "iva_105": numero_o_0,
  "percepciones_iibb": numero_o_0,
  "percepciones_iva": numero_o_0,
  "total": numero_o_0,
  "items": [{"descripcion": "string", "cantidad": numero, "unidad": "kg|l|u", "precio_unitario": numero, "subtotal": numero}],
  "confianza": {"razon_social": 0-100, "nro_factura": 0-100, "fecha_emision": 0-100, "total": 0-100, "neto_gravado": 0-100},
  "confianza_global": 0-100,
  "advertencias": ["string corto"]
}

VALIDACIÓN INTERNA antes de responder:
- ¿La suma de items.subtotal coincide aproximadamente con neto_gravado? Si no, baja confianza.
- ¿neto_gravado + iva_21 + iva_105 + percepciones suma aproximadamente al total? Si no, agregá advertencia "totales no cuadran".
- Si total parece desproporcionadamente grande (>10M para una factura típica), revisá los separadores decimales una vez más antes de responder.

Si la factura está borrosa o no podés leer claramente, bajá confianza_global a <50 y NO inventes números.`}
            ]
          }]
        })
      });

      const data=await response.json();
      const text=data.content?.map(c=>c.text||"").join("");
      const clean=text.replace(/```json|```/g,"").trim();
      const parsed=JSON.parse(clean);

      // Defensa en profundidad (bug #41 escalada): la IA puede alucinar
      // montos completos, no solo multiplicar por 100. Tres chequeos:
      //  1. Magnitud: monto absoluto >10M ARS para una factura de gastronomía
      //     ya es excepción — vale la pena interrumpir aunque sea legítimo.
      //  2. Coherencia items: total >> suma de items implica alucinación.
      //  3. Coherencia desglose: neto+iva+percepciones >> total implica que
      //     uno de los componentes está inflado x100.
      const MAX_MONTO_RAZONABLE=10_000_000; // 10M ARS — ↓ desde 100M (bug #41)
      const camposMonto=["neto_gravado","iva_21","iva_105","percepciones_iibb","percepciones_iva","total"];
      const sospechososMagnitud=camposMonto.filter(c=>Number(parsed[c]||0)>MAX_MONTO_RAZONABLE);
      const total=Number(parsed.total||0);
      const sumaItems=Array.isArray(parsed.items)?parsed.items.reduce((s:number,it:any)=>s+Number(it.subtotal||0),0):0;
      const sumaDesglose=Number(parsed.neto_gravado||0)+Number(parsed.iva_21||0)+Number(parsed.iva_105||0)+Number(parsed.percepciones_iibb||0)+Number(parsed.percepciones_iva||0);
      const incoherenciaItems=sumaItems>0&&total>0&&total>sumaItems*2;
      const incoherenciaDesglose=total>0&&sumaDesglose>total*1.5;
      if(sospechososMagnitud.length>0||incoherenciaItems||incoherenciaDesglose){
        const lineas=[
          "⚠ La IA devolvió montos sospechosos:",
          "",
          ...sospechososMagnitud.map(c=>"  • "+c+" excede $10M: $"+Number(parsed[c]).toLocaleString("es-AR")),
          ...(incoherenciaItems?["  • total ($"+total.toLocaleString("es-AR")+") es >2x la suma de items ($"+sumaItems.toLocaleString("es-AR")+") — posible alucinación"]:[]),
          ...(incoherenciaDesglose?["  • neto+iva+percepciones ($"+sumaDesglose.toLocaleString("es-AR")+") >> total ($"+total.toLocaleString("es-AR")+") — un componente está inflado"]:[]),
          "",
          "Si la factura es real, podés aceptar y editar los montos manualmente antes de guardar.",
          "Cancelá para descartar y volver a leer la factura.",
        ];
        const ok=confirm(lineas.join("\n"));
        if(!ok){setLoading(false);return;}
      }

      setResultado(parsed);

      // Pre-llenar el form con los datos extraídos
      const cuitDet=(parsed.cuit_emisor||"").replace(/-/g,"");
      const razon=(parsed.razon_social||"").toLowerCase();
      const provMatch=proveedores.find(p=>{
        const nombre=p.nombre.toLowerCase();
        const provCuit=(p.cuit||"").replace(/-/g,"");
        if(cuitDet&&provCuit===cuitDet) return true;
        if(razon.length>=10&&nombre.includes(razon.slice(0,10))) return true;
        if(nombre.length>=10&&razon.includes(nombre.slice(0,10))) return true;
        return false;
      });
      setForm(f=>({
        ...f,
        prov_id:provMatch?.id||"",
        nro:parsed.nro_factura||"",
        fecha:parsed.fecha_emision||"",
        venc:parsed.fecha_vencimiento||"",
        neto:parseMonto(parsed.neto_gravado),
        iva21:parseMonto(parsed.iva_21),
        iva105:parseMonto(parsed.iva_105),
        iibb:parseMonto(parsed.percepciones_iibb)+parseMonto(parsed.percepciones_iva),
        total:parseMonto(parsed.total),
        cat:provMatch?.cat||"",
      }));
    }catch(err){
      alert("Error al leer la factura. Intentá con una imagen más clara o cargala manualmente.");
      console.error(err);
    }
    setLoading(false);
  };

  const guardar=async()=>{
    if(!form.prov_id&&!form.local_id){alert("⚠ Seleccioná el proveedor y el local antes de guardar.");return;}
    if(!form.prov_id){alert("⚠ Seleccioná el proveedor antes de guardar.");return;}
    if(!form.local_id){alert("⚠ Seleccioná el local antes de guardar.");return;}
    if(!form.nro){alert("⚠ Completá el número de factura.");return;}

    // Warning de duplicados (bug #29): mismo flow que Compras.tsx. Prev fecha
    // y total del form detectado por IA + confirmado por usuario.
    const totalForm = parseMonto(form.total);
    if (form.fecha && form.prov_id && totalForm > 0) {
      const { data: posibles } = await db.from("facturas")
        .select("nro, fecha, total, estado, tipo")
        .eq("prov_id", parseInt(form.prov_id))
        .eq("fecha", form.fecha)
        .neq("estado", "anulada");
      const dup = (posibles || []).find(p => {
        const diff = Math.abs(Number(p.total || 0) - totalForm);
        const tol = Math.max(1, Math.abs(totalForm) * 0.01);
        return diff <= tol && (p.tipo || "factura") !== "nota_credito";
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

    setGuardando(true);
    const id=genId("FACT");

    // Subir archivo original a Supabase Storage si viene adjunto
    let imagen_url=null;
    if(archivo){
      const ext=(archivo.name.split(".").pop()||"bin").toLowerCase();
      const path=`${id}.${ext}`;
      const {error:upErr}=await db.storage.from("facturas").upload(path,archivo,{contentType:archivo.type||"application/octet-stream",upsert:false});
      if(upErr){
        alert("Error subiendo la imagen: "+upErr.message);
        setGuardando(false);
        return;
      }
      imagen_url=path;
    }

    const confGlobal=resultado?.confianza_global??100;
    const estado=confGlobal<70?"revision":"pendiente";
    const {error:insErr}=await db.from("facturas").insert([{...form,id,prov_id:parseInt(form.prov_id),local_id:parseInt(form.local_id),neto:parseMonto(form.neto),iva21:parseMonto(form.iva21),iva105:parseMonto(form.iva105),iibb:parseMonto(form.iibb),total:parseMonto(form.total),estado,pagos:[],imagen_url,fecha:form.fecha||null,venc:form.venc||null}]);
    if(insErr){
      // Rollback del archivo si el insert falló, así no queda huérfano
      if(imagen_url) await db.storage.from("facturas").remove([imagen_url]);
      alert("Error guardando la factura: "+insErr.message);
      setGuardando(false);
      return;
    }

    const prov=proveedores.find(p=>p.id===parseInt(form.prov_id));
    if(prov)await db.from("proveedores").update({saldo:(prov.saldo||0)+parseMonto(form.total)}).eq("id",prov.id);
    setGuardando(false);setArchivo(null);setPreview(null);setResultado(null);
    setForm({local_id:localActivo||"",prov_id:"",fecha:"",venc:"",nro:"",neto:0,iva21:0,iva105:0,iibb:0,total:0,cat:""});
    alert("✓ Factura cargada correctamente");
  };

  const guardarProvInline = async () => {
    if (provSaving || !provModal?.nombre) return;
    setProvSaving(true);
    try {
      const { data, error } = await db.from("proveedores")
        .insert([{
          nombre: provModal.nombre,
          cuit: provModal.cuit || null,
          cat: provModal.cat || "OTROS",
          estado: "Activo",
          saldo: 0,
        }])
        .select()
        .single();
      if (error) { alert("No se pudo crear el proveedor: " + error.message); return; }
      if (data) {
        setProveedores(prev => [...prev, data].sort((a, b) => (a.nombre || "").localeCompare(b.nombre || "")));
        setForm(f => ({ ...f, prov_id: String(data.id), cat: data.cat || f.cat }));
        setProvModal(null);
      }
    } finally {
      setProvSaving(false);
    }
  };

  return (
    <div>
      <div className="ph-row">
        <div><div className="ph-title">Lector de Facturas IA</div></div>
      </div>

      <div className="grid2">
        <div className="panel">
          <div className="panel-hd"><span className="panel-title">1. Subir Factura</span></div>
          <div style={{padding:16}}>
            <div style={{border:"2px dashed var(--bd2)",borderRadius:"var(--r)",padding:32,textAlign:"center",background:"var(--s2)",marginBottom:12}}>
              <input type="file" accept=".pdf,.jpg,.jpeg,.png" style={{display:"none"}} id="factura-upload"
                onChange={e=>{
                  const f=e.target.files?.[0];
                  if(!f)return;
                  setArchivo(f);setResultado(null);
                  if(f.type.startsWith("image/"))setPreview(URL.createObjectURL(f));
                  else setPreview(null);
                }}/>
              <label htmlFor="factura-upload" style={{cursor:"pointer"}}>
                <div style={{fontSize:32,marginBottom:8}}>📄</div>
                <div style={{fontFamily:"'Inter',sans-serif",fontWeight:500,fontSize:14,color:"var(--acc)"}}>Seleccionar archivo</div>
                <div style={{fontSize:11,color:"var(--muted)",marginTop:4}}>PDF, JPG o PNG — Factura A, B o C</div>
              </label>
            </div>
            {archivo&&<div style={{fontSize:11,color:"var(--success)",marginBottom:12}}>✓ {archivo.name}</div>}
            {preview&&<img src={preview} alt="preview" style={{width:"100%",borderRadius:"var(--r)",marginBottom:12,maxHeight:300,objectFit:"contain"}}/>}
            <button className="btn btn-acc" style={{width:"100%",justifyContent:"center"}} onClick={leerConIA} disabled={!archivo||loading}>
              {loading?"🔍 Analizando con IA...":"✨ Leer con IA"}
            </button>
          </div>
        </div>

        <div className="panel">
          <div className="panel-hd"><span className="panel-title">2. Verificar y Confirmar</span></div>
          <div style={{padding:16}}>
            {!resultado&&!loading&&<div className="empty" style={{padding:40}}>Subí una factura y hacé click en "Leer con IA"</div>}
            {loading&&<div className="loading">La IA está leyendo la factura...</div>}
            {resultado&&(() => {
              const conf=resultado.confianza||{};
              const confGlobal=resultado.confianza_global??100;
              const advertencias=resultado.advertencias||[];
              const globalColor=confGlobal>=80?"var(--success)":confGlobal>=50?"var(--warn)":"var(--danger)";
              const globalLabel=confGlobal>=80?"Alta confianza":confGlobal>=50?"Revisar campos marcados":"Baja confianza — revisá todo";
              const globalRgb=confGlobal>=80?"107,158,122":confGlobal>=50?"196,154,60":"196,97,74";
              const campoBorder=(campo:string)=>{
                const c=conf[campo];
                if(c===undefined||c===null) return "1px solid var(--bd)";
                if(c>=80) return "1px solid var(--bd)";
                if(c>=50) return "1px solid var(--warn)";
                return "1px solid var(--danger)";
              };
              return (<>
                <div style={{padding:"10px 14px",borderRadius:"var(--r)",marginBottom:12,background:`rgba(${globalRgb},0.1)`,border:`1px solid ${globalColor}33`,display:"flex",alignItems:"center",justifyContent:"space-between"}}>
                  <span style={{fontSize:12,color:globalColor}}>{globalLabel}</span>
                  <span style={{fontSize:20,fontWeight:500,color:globalColor}}>{confGlobal}%</span>
                </div>
                {advertencias.length>0 && (
                  <div style={{marginBottom:12}}>
                    {advertencias.map((a:string,i:number)=>(
                      <div key={i} style={{fontSize:10,color:"var(--warn)",marginBottom:4}}>⚠ {a}</div>
                    ))}
                  </div>
                )}
                {resultado.razon_social&&<div style={{fontSize:11,color:"var(--muted2)",marginBottom:12}}>Emisor detectado: <strong style={{color:"var(--txt)"}}>{resultado.razon_social}</strong> · CUIT: {resultado.cuit_emisor}</div>}

                <div className="field"><label>Proveedor *</label>
                  <div style={{display:"flex",gap:6}}>
                    <select value={form.prov_id} onChange={e=>setForm({...form,prov_id:e.target.value})}
                      style={{flex:1,border:campoBorder("razon_social")}}>
                      <option value="">Seleccioná...</option>
                      {proveedores.map(p=><option key={p.id} value={p.id}>{p.nombre}</option>)}
                    </select>
                    <button className="btn btn-ghost btn-sm" type="button"
                      title="Crear un proveedor nuevo con los datos detectados por IA"
                      onClick={()=>setProvModal({
                        nombre: resultado.razon_social || "",
                        cuit: resultado.cuit_emisor || "",
                        cat: CATEGORIAS_COMPRA[0] || "OTROS",
                      })}>
                      + Nuevo
                    </button>
                  </div>
                </div>
                <div className="form2">
                  <div className="field"><label>Local *</label>
                    <select value={form.local_id} onChange={e=>setForm({...form,local_id:e.target.value})}>
                      <option value="">Seleccioná...</option>
                      {locales.map(l=><option key={l.id} value={l.id}>{l.nombre}</option>)}
                    </select>
                  </div>
                  <div className="field"><label>Nº Factura</label>
                    <input value={form.nro} onChange={e=>setForm({...form,nro:e.target.value})} style={{border:campoBorder("nro_factura")}}/>
                  </div>
                </div>
                <div className="form2">
                  <div className="field"><label>Fecha</label>
                    <input type="date" value={form.fecha} onChange={e=>setForm({...form,fecha:e.target.value})} style={{border:campoBorder("fecha_emision")}}/>
                  </div>
                  <div className="field"><label>Vencimiento</label><input type="date" value={form.venc||""} onChange={e=>setForm({...form,venc:e.target.value})}/></div>
                </div>
                <div style={{background:"var(--s2)",padding:12,borderRadius:"var(--r)",marginBottom:12}}>
                  {[["Neto Gravado","neto","neto_gravado"],["IVA 21%","iva21",null],["IVA 10.5%","iva105",null],["Perc. IIBB","iibb",null]].map(([l,k,confKey])=>(
                    <div key={k as string} style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
                      <span style={{fontSize:11,color:"var(--muted2)"}}>{l}</span>
                      <input type="number" step="0.01" value={form[k as string]} onChange={e=>setForm({...form,[k as string]:e.target.value})}
                        style={{width:120,background:"var(--bg)",border:confKey?campoBorder(confKey as string):"1px solid var(--bd)",color:"var(--txt)",padding:"4px 8px",fontFamily:"'DM Mono',monospace",fontSize:12,borderRadius:"var(--r)",textAlign:"right"}}/>
                    </div>
                  ))}
                  <div style={{display:"flex",justifyContent:"space-between",borderTop:"1px solid var(--bd)",paddingTop:8}}>
                    <span style={{fontWeight:600}}>TOTAL</span>
                    <input type="number" step="0.01" value={form.total} onChange={e=>setForm({...form,total:e.target.value})}
                      style={{width:120,background:"var(--bg)",border:conf.total!==undefined&&conf.total<80?campoBorder("total"):"1px solid var(--acc)",color:"var(--acc)",padding:"4px 8px",fontFamily:"'Inter',sans-serif",fontWeight:500,fontSize:14,borderRadius:"var(--r)",textAlign:"right"}}/>
                  </div>
                </div>

                {resultado.items?.length>0&&(()=>{
                  // Bug #41 capa 3: si la suma de items no coincide con
                  // el neto detectado, mostrar warning sobre los ítems.
                  // Tolerancia 5% — los ítems típicos no incluyen IVA pero
                  // sí descuentos/redondeos chicos. Si la diferencia es mayor,
                  // probable alucinación o lectura incompleta.
                  const sumaItems=resultado.items.reduce((s:number,it:any)=>s+Number(it.subtotal||0),0);
                  const netoDet=parseMonto(form.neto);
                  const diff=netoDet>0?Math.abs(sumaItems-netoDet)/netoDet:0;
                  const incoherente=netoDet>0&&sumaItems>0&&diff>0.05;
                  return (
                    <div style={{marginBottom:12}}>
                      <div style={{fontSize:9,letterSpacing:2,textTransform:"uppercase",color:"var(--muted)",marginBottom:8}}>Ítems detectados ({resultado.items.length})</div>
                      {incoherente&&(
                        <div className="alert alert-danger" style={{marginBottom:8,fontSize:11}}>
                          ⚠ Los items no suman al neto detectado — revisá manualmente. Suma items: <strong>{fmt_$(sumaItems)}</strong> vs neto: <strong>{fmt_$(netoDet)}</strong>.
                        </div>
                      )}
                      {resultado.items.map((it:any,i:number)=>(
                        <div key={i} style={{display:"flex",justifyContent:"space-between",padding:"6px 0",borderBottom:"1px solid var(--bd)",fontSize:11}}>
                          <span>{it.descripcion}</span>
                          <span style={{color:"var(--muted2)"}}>{it.cantidad} {it.unidad} · {fmt_$(it.subtotal)}</span>
                        </div>
                      ))}
                    </div>
                  );
                })()}

                <button className="btn btn-acc" style={{width:"100%",justifyContent:"center"}} onClick={guardar} disabled={guardando}>
                  {guardando?"Guardando...":"✓ Guardar Factura"}
                </button>
              </>);
            })()}
          </div>
        </div>
      </div>

      {provModal && (
        <div className="overlay" onClick={()=>setProvModal(null)}>
          <div className="modal" style={{width:480}} onClick={e=>e.stopPropagation()}>
            <div className="modal-hd">
              <div className="modal-title">Nuevo proveedor</div>
              <button className="close-btn" onClick={()=>setProvModal(null)}>✕</button>
            </div>
            <div className="modal-body">
              <div className="alert alert-info" style={{marginBottom:12,fontSize:11}}>Datos pre-cargados desde la factura. Podés editarlos antes de guardar.</div>
              <div className="field">
                <label>Razón Social *</label>
                <input value={provModal.nombre} onChange={e=>setProvModal({...provModal,nombre:e.target.value})} placeholder="Empresa S.A."/>
              </div>
              <div className="form2">
                <div className="field">
                  <label>CUIT</label>
                  <input value={provModal.cuit||""} onChange={e=>setProvModal({...provModal,cuit:e.target.value})} placeholder="30-12345678-0"/>
                </div>
                <div className="field">
                  <label>Categoría EERR</label>
                  <select value={provModal.cat} onChange={e=>setProvModal({...provModal,cat:e.target.value})}>
                    {CATEGORIAS_COMPRA.map(c=><option key={c}>{c}</option>)}
                  </select>
                </div>
              </div>
            </div>
            <div className="modal-ft">
              <button className="btn btn-sec" onClick={()=>setProvModal(null)}>Cancelar</button>
              <button className="btn btn-acc" onClick={guardarProvInline} disabled={provSaving||!provModal.nombre}>
                {provSaving?"Guardando...":"Crear y seleccionar"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
