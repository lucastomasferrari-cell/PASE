import { useState, useEffect } from "react";
import { db } from "../lib/supabase";
import { fmt_d, fmt_$, genId } from "../lib/utils";
import { useCategorias } from "../lib/useCategorias";
import { UNIDADES } from "../lib/constants";

export default function LectorFacturasIA({ locales, localActivo }) {
  const { CATEGORIAS_COMPRA } = useCategorias();
  const [archivo,setArchivo]=useState(null);
  const [preview,setPreview]=useState(null);
  const [loading,setLoading]=useState(false);
  const [resultado,setResultado]=useState(null);
  const [proveedores,setProveedores]=useState([]);
  const [insumos,setInsumos]=useState([]);
  const [guardando,setGuardando]=useState(false);
  const [form,setForm]=useState({local_id:localActivo||"",prov_id:"",fecha:"",venc:"",nro:"",neto:0,iva21:0,iva105:0,iibb:0,total:0,cat:""});

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
          model:"claude-sonnet-4-20250514",
          max_tokens:1500,
          messages:[{
            role:"user",
            content:[
              {type:isImg?"image":"document",source:{type:"base64",media_type:mediaType,data:base64}},
              {type:"text",text:`Sos un asistente de contabilidad argentina. Analizá esta factura y extraé los datos en formato JSON exacto, sin texto adicional, sin markdown, solo el JSON puro.

Formato requerido:
{
  "razon_social": "nombre del emisor",
  "cuit_emisor": "XX-XXXXXXXX-X",
  "tipo_factura": "A o B o C o X",
  "nro_factura": "XXXX-XXXXXXXX",
  "fecha_emision": "YYYY-MM-DD",
  "fecha_vencimiento": "YYYY-MM-DD o null",
  "neto_gravado": 0,
  "iva_21": 0,
  "iva_105": 0,
  "percepciones_iibb": 0,
  "percepciones_iva": 0,
  "total": 0,
  "items": [
    {"descripcion": "nombre producto", "cantidad": 0, "unidad": "kg/l/u", "precio_unitario": 0, "subtotal": 0}
  ],
  "confianza": {
    "razon_social": 0,
    "nro_factura": 0,
    "fecha_emision": 0,
    "total": 0,
    "neto_gravado": 0
  },
  "confianza_global": 0,
  "advertencias": []
}

Reglas:
- Si algún campo no existe en la factura, poné 0 o null según corresponda. Los montos siempre como números sin puntos ni comas.
- En "confianza" y "confianza_global" devolvé un número de 0 a 100 indicando qué tan seguro estás de cada dato extraído. 100 = nítido y sin ambigüedad, 50 = legible pero hay dudas, 0 = ilegible o inferido.
- "confianza_global" debe reflejar el peor campo crítico (total, nro_factura, razon_social) — si cualquiera de esos es bajo, bajá el global.
- En "advertencias" poné un array de strings cortos (máx 3) describiendo problemas específicos: "neto + IVA no cuadra con total", "CUIT parcialmente ilegible", "fecha ambigua", etc. Si no hay problemas, devolvé [].`}
            ]
          }]
        })
      });

      const data=await response.json();
      const text=data.content?.map(c=>c.text||"").join("");
      const clean=text.replace(/```json|```/g,"").trim();
      const parsed=JSON.parse(clean);
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
        neto:parsed.neto_gravado||0,
        iva21:parsed.iva_21||0,
        iva105:parsed.iva_105||0,
        iibb:(parsed.percepciones_iibb||0)+(parsed.percepciones_iva||0),
        total:parsed.total||0,
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
    const {error:insErr}=await db.from("facturas").insert([{...form,id,prov_id:parseInt(form.prov_id),local_id:parseInt(form.local_id),neto:parseFloat(form.neto)||0,iva21:parseFloat(form.iva21)||0,iva105:parseFloat(form.iva105)||0,iibb:parseFloat(form.iibb)||0,total:parseFloat(form.total)||0,estado,pagos:[],imagen_url}]);
    if(insErr){
      // Rollback del archivo si el insert falló, así no queda huérfano
      if(imagen_url) await db.storage.from("facturas").remove([imagen_url]);
      alert("Error guardando la factura: "+insErr.message);
      setGuardando(false);
      return;
    }

    const prov=proveedores.find(p=>p.id===parseInt(form.prov_id));
    if(prov)await db.from("proveedores").update({saldo:(prov.saldo||0)+parseFloat(form.total)}).eq("id",prov.id);
    setGuardando(false);setArchivo(null);setPreview(null);setResultado(null);
    setForm({local_id:localActivo||"",prov_id:"",fecha:"",venc:"",nro:"",neto:0,iva21:0,iva105:0,iibb:0,total:0,cat:""});
    alert("✓ Factura cargada correctamente");
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
                  const f=e.target.files[0];
                  if(!f)return;
                  setArchivo(f);setResultado(null);
                  if(f.type.startsWith("image/")){const url=URL.createObjectURL(f);setPreview(url);}
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
                  <select value={form.prov_id} onChange={e=>setForm({...form,prov_id:e.target.value})}
                    style={{border:campoBorder("razon_social")}}>
                    <option value="">Seleccioná...</option>
                    {proveedores.map(p=><option key={p.id} value={p.id}>{p.nombre}</option>)}
                  </select>
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
                      <input type="number" value={form[k as string]} onChange={e=>setForm({...form,[k as string]:e.target.value})}
                        style={{width:120,background:"var(--bg)",border:confKey?campoBorder(confKey as string):"1px solid var(--bd)",color:"var(--txt)",padding:"4px 8px",fontFamily:"'DM Mono',monospace",fontSize:12,borderRadius:"var(--r)",textAlign:"right"}}/>
                    </div>
                  ))}
                  <div style={{display:"flex",justifyContent:"space-between",borderTop:"1px solid var(--bd)",paddingTop:8}}>
                    <span style={{fontWeight:600}}>TOTAL</span>
                    <input type="number" value={form.total} onChange={e=>setForm({...form,total:e.target.value})}
                      style={{width:120,background:"var(--bg)",border:conf.total!==undefined&&conf.total<80?campoBorder("total"):"1px solid var(--acc)",color:"var(--acc)",padding:"4px 8px",fontFamily:"'Inter',sans-serif",fontWeight:500,fontSize:14,borderRadius:"var(--r)",textAlign:"right"}}/>
                  </div>
                </div>

                {resultado.items?.length>0&&(
                  <div style={{marginBottom:12}}>
                    <div style={{fontSize:9,letterSpacing:2,textTransform:"uppercase",color:"var(--muted)",marginBottom:8}}>Ítems detectados ({resultado.items.length})</div>
                    {resultado.items.map((it,i)=>(
                      <div key={i} style={{display:"flex",justifyContent:"space-between",padding:"6px 0",borderBottom:"1px solid var(--bd)",fontSize:11}}>
                        <span>{it.descripcion}</span>
                        <span style={{color:"var(--muted2)"}}>{it.cantidad} {it.unidad} · {fmt_$(it.subtotal)}</span>
                      </div>
                    ))}
                  </div>
                )}

                <button className="btn btn-acc" style={{width:"100%",justifyContent:"center"}} onClick={guardar} disabled={guardando}>
                  {guardando?"Guardando...":"✓ Guardar Factura"}
                </button>
              </>);
            })()}
          </div>
        </div>
      </div>
    </div>
  );
}
