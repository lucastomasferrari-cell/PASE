import { useState, useEffect } from "react";
import { db } from "../lib/supabase";
import { fmt_d, fmt_$, genId } from "../lib/utils";
import { CATEGORIAS_COMPRA, UNIDADES } from "../lib/constants";

export default function LectorFacturasIA({ locales, localActivo }) {
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
  ]
}

Si algún campo no existe en la factura, poné 0 o null según corresponda. Los montos siempre como números sin puntos ni comas.`}
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
      const provMatch=proveedores.find(p=>
        parsed.razon_social&&p.nombre.toLowerCase().includes(parsed.razon_social.toLowerCase().slice(0,8))
      );
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

    const {error:insErr}=await db.from("facturas").insert([{...form,id,prov_id:parseInt(form.prov_id),local_id:parseInt(form.local_id),neto:parseFloat(form.neto)||0,iva21:parseFloat(form.iva21)||0,iva105:parseFloat(form.iva105)||0,iibb:parseFloat(form.iibb)||0,total:parseFloat(form.total)||0,estado:"pendiente",pagos:[],imagen_url}]);
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
            {resultado&&(
              <>
                <div style={{marginBottom:12,padding:10,background:"rgba(34,197,94,.08)",border:"1px solid rgba(34,197,94,.3)",borderRadius:"var(--r)",fontSize:11,color:"var(--success)"}}>
                  ✓ Datos extraídos. Verificá que todo esté correcto antes de guardar.
                </div>
                {resultado.razon_social&&<div style={{fontSize:11,color:"var(--muted2)",marginBottom:12}}>Emisor detectado: <strong style={{color:"var(--txt)"}}>{resultado.razon_social}</strong> · CUIT: {resultado.cuit_emisor}</div>}

                <div className="field"><label>Proveedor *</label>
                  <select value={form.prov_id} onChange={e=>setForm({...form,prov_id:e.target.value})}>
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
                  <div className="field"><label>Nº Factura</label><input value={form.nro} onChange={e=>setForm({...form,nro:e.target.value})}/></div>
                </div>
                <div className="form2">
                  <div className="field"><label>Fecha</label><input type="date" value={form.fecha} onChange={e=>setForm({...form,fecha:e.target.value})}/></div>
                  <div className="field"><label>Vencimiento</label><input type="date" value={form.venc||""} onChange={e=>setForm({...form,venc:e.target.value})}/></div>
                </div>
                <div style={{background:"var(--s2)",padding:12,borderRadius:"var(--r)",marginBottom:12}}>
                  {[["Neto Gravado","neto"],["IVA 21%","iva21"],["IVA 10.5%","iva105"],["Perc. IIBB","iibb"]].map(([l,k])=>(
                    <div key={k} style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
                      <span style={{fontSize:11,color:"var(--muted2)"}}>{l}</span>
                      <input type="number" value={form[k]} onChange={e=>setForm({...form,[k]:e.target.value})}
                        style={{width:120,background:"var(--bg)",border:"1px solid var(--bd)",color:"var(--txt)",padding:"4px 8px",fontFamily:"'DM Mono',monospace",fontSize:12,borderRadius:"var(--r)",textAlign:"right"}}/>
                    </div>
                  ))}
                  <div style={{display:"flex",justifyContent:"space-between",borderTop:"1px solid var(--bd)",paddingTop:8}}>
                    <span style={{fontWeight:600}}>TOTAL</span>
                    <input type="number" value={form.total} onChange={e=>setForm({...form,total:e.target.value})}
                      style={{width:120,background:"var(--bg)",border:"1px solid var(--acc)",color:"var(--acc)",padding:"4px 8px",fontFamily:"'Inter',sans-serif",fontWeight:500,fontSize:14,borderRadius:"var(--r)",textAlign:"right"}}/>
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
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
