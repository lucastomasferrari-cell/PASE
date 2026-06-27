import { useState, useEffect, useRef } from "react";
import { db } from "../lib/supabase";
import { fmt_d, fmt_$, genId, parseMonto } from "@pase/shared/utils";
import { useCategorias } from "../lib/useCategorias";
import { localesVisibles } from "../lib/auth";
import { Modal } from "../components/ui";
import { useToast } from "../hooks/useToast";
import { ToastComponent } from "../components/Toast";
import type { Usuario, Local } from "../types/auth";
import type { Proveedor } from "../types/finanzas";

// Shape del JSON que devuelve Claude vía /api/claude (cuando parseamos el
// JSON estructurado de la factura). Refleja exactamente el formato pedido
// en el prompt — campos numéricos pueden venir como number o como string
// (la IA a veces devuelve "166.876,67" como string), por eso el front usa
// parseMonto al consumirlos.
interface IAFacturaItem {
  descripcion: string;
  cantidad: number;
  unidad: string;
  precio_unitario: number;
  subtotal: number;
}

interface IAFacturaResponse {
  razon_social?: string;
  cuit_emisor?: string;
  tipo_factura?: string;
  nro_factura?: string;
  fecha_emision?: string;
  fecha_vencimiento?: string | null;
  neto_gravado?: number | string;
  iva_21?: number | string;
  iva_105?: number | string;
  percepciones_iibb?: number | string;
  percepciones_iva?: number | string;
  total?: number | string;
  // Discriminación fiscal AR ampliada (Lucas 10-jun, Libro IVA del contador).
  iva_27?: number | string;
  no_gravado?: number | string;
  exento?: number | string;
  iibb_caba?: number | string;
  iibb_ba?: number | string;
  iibb_otros?: number | string;
  iibb_otros_jurisdiccion?: string | null;
  perc_ganancias?: number | string;
  retencion_suss?: number | string;
  items?: IAFacturaItem[];
  confianza?: Partial<Record<"razon_social" | "nro_factura" | "fecha_emision" | "total" | "neto_gravado", number>>;
  confianza_global?: number;
  advertencias?: string[];
}

// Forma mínima del state provModal (creación inline de proveedor desde
// los datos detectados por la IA).
interface ProvModalForm {
  nombre: string;
  cuit: string;
  cat: string;
}

interface LectorFacturasIAProps {
  user: Usuario;
  locales: Local[];
  localActivo: number | null;
  onSaved?: () => void;
}

export default function LectorFacturasIA({ user, locales, localActivo, onSaved }: LectorFacturasIAProps) {
  const { toast, showToast, showError } = useToast();
  // Locales del dropdown — solo los autorizados (encargado/admin/dueño).
  const visLocs = localesVisibles(user);
  const localesDisp = visLocs === null ? locales : locales.filter((l: Local) => visLocs.includes(l.id));
  const { CATEGORIAS_COMPRA } = useCategorias();
  const [archivo,setArchivo]=useState<File|null>(null);
  const [preview,setPreview]=useState<string|null>(null);
  const [loading,setLoading]=useState(false);
  const [resultado,setResultado]=useState<IAFacturaResponse | null>(null);
  const [proveedores,setProveedores]=useState<Proveedor[]>([]);
  const [guardando,setGuardando]=useState(false);
  // Form state — incluye discriminación fiscal AR (Lucas 10-jun).
  // Los campos avanzados van en el panel <details> colapsable; el usuario
  // los confirma/edita después de leer con IA.
  const formVacio = {
    local_id: localActivo || "" as string|number,
    prov_id: "" as string,
    fecha: "", venc: "", nro: "",
    neto: 0 as number|string, iva21: 0 as number|string, iva105: 0 as number|string,
    iibb: 0 as number|string, perc_iva: 0 as number|string, total: 0 as number|string,
    cat: "",
    // discriminación fiscal ampliada
    iva27: 0 as number|string,
    no_gravado: 0 as number|string,
    exento: 0 as number|string,
    iibb_caba: 0 as number|string,
    iibb_ba: 0 as number|string,
    iibb_otros: 0 as number|string,
    iibb_otros_jurisdiccion: "",
    perc_ganancias: 0 as number|string,
    retencion_suss: 0 as number|string,
  };
  const [form,setForm]=useState<typeof formVacio>(formVacio);
  // Sync form.local_id con sidebar (bug fix 29-may, cache stale del localActivo).
  // Solo update si el user NO tocó el campo manualmente Y aún no procesó factura.
  useEffect(() => {
    if (localActivo == null) return;
    if (resultado) return; // si ya hay factura procesada, no pisar la elección
    setForm(f => f.local_id === localActivo ? f : { ...f, local_id: localActivo });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localActivo]);
  // Modal inline para crear un proveedor nuevo cuando el emisor detectado
  // por IA no matchea con ninguno existente.
  const [provModal,setProvModal]=useState<ProvModalForm | null>(null);
  const [provSaving,setProvSaving]=useState(false);

  useEffect(()=>{
    db.from("proveedores").select("*").eq("estado","Activo").order("nombre")
      .then(({data:p})=>setProveedores((p as Proveedor[]) || []));
  },[]);

  const toBase64=(file: File): Promise<string>=>new Promise((res,rej)=>{
    const r=new FileReader();
    r.onload=()=>{
      // FileReader.result puede ser string|ArrayBuffer; readAsDataURL siempre
      // devuelve string ("data:tipo/sub;base64,xxx"), pero el tipo es union.
      const result = typeof r.result === "string" ? r.result : "";
      res(result.split(",")[1] || "");
    };
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

      // El proxy /api/claude requiere Authorization: Bearer <supabase_jwt>
      // desde el sprint 2026-05-06 (cerramos el endpoint que estaba abierto
      // al mundo). Levantamos el access_token de la sesión actual.
      const sess = (await db.auth.getSession()).data.session;
      if (!sess?.access_token) {
        throw new Error('Sesión expirada. Recargá la página y volvé a entrar.');
      }
      const response=await fetch("/api/claude",{
        method:"POST",
        headers:{
          "Content-Type":"application/json",
          "Authorization": `Bearer ${sess.access_token}`,
        },
        // Si la API responde 4xx puede ser: Vercel auth (HTML), error de
        // Anthropic (JSON con `error.message`), nuestro propio _user-auth
        // (401/403/500), o el proxy mismo. El catch al final detecta cada
        // caso y muestra el mensaje real al user.
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
  "iva_27": numero_o_0,
  "no_gravado": numero_o_0,
  "exento": numero_o_0,
  "iibb_caba": numero_o_0,
  "iibb_ba": numero_o_0,
  "iibb_otros": numero_o_0,
  "iibb_otros_jurisdiccion": "string o null (ej: 'Córdoba')",
  "percepciones_iva": numero_o_0,
  "perc_ganancias": numero_o_0,
  "retencion_suss": numero_o_0,
  "percepciones_iibb": numero_o_0,
  "total": numero_o_0,
  "items": [{"descripcion": "string", "cantidad": numero, "unidad": "kg|l|u", "precio_unitario": numero, "subtotal": numero}],
  "confianza": {"razon_social": 0-100, "nro_factura": 0-100, "fecha_emision": 0-100, "total": 0-100, "neto_gravado": 0-100},
  "confianza_global": 0-100,
  "advertencias": ["string corto"]
}

REGLAS PARA DISCRIMINAR PERCEPCIONES IIBB (importante para el contador):
- Si la factura dice "Perc IIBB CABA" o "Perc IIBB Cdad. Bs. As." → iibb_caba.
- Si dice "Perc IIBB Bs. As." o "Perc IIBB Pcia. Bs. As." (provincia) → iibb_ba.
- Si dice cualquier otra jurisdicción (Córdoba, Mendoza, Santa Fe, etc) → iibb_otros, y completá iibb_otros_jurisdiccion con el nombre.
- Si solo dice "Perc IIBB" sin especificar jurisdicción → iibb_otros con jurisdicción null.
- "percepciones_iibb" debe ser la SUMA de las 3 anteriores (cache).

VALIDACIÓN INTERNA antes de responder:
- ¿La suma de items.subtotal coincide aproximadamente con neto_gravado? Si no, baja confianza.
- ¿neto_gravado + no_gravado + exento + iva_21 + iva_105 + iva_27 + percepciones suma aproximadamente al total? Si no, agregá advertencia "totales no cuadran".
- Si total parece desproporcionadamente grande (>10M para una factura típica), revisá los separadores decimales una vez más antes de responder.

Si la factura está borrosa o no podés leer claramente, bajá confianza_global a <50 y NO inventes números.
Si la factura es simple (solo IVA 21%) y NO ves ninguna percepción/retención/exención adicional, dejá esos campos en 0 — no inventes.`}
            ]
          }]
        })
      });

      // Si el proxy/Anthropic respondió con error, leer el body y construir
      // un mensaje útil. Antes el catch genérico transformaba todo en
      // "imagen poco clara" — confundía al usuario porque el problema
      // real era de red/autorización.
      if (!response.ok) {
        let detalle = `HTTP ${response.status}`;
        try {
          const ct = response.headers.get('content-type') || '';
          if (ct.includes('application/json')) {
            const err: { error?: { message?: string }; message?: string } = await response.json();
            detalle = err.error?.message || err.message || JSON.stringify(err).slice(0, 200);
          } else {
            const txt = await response.text();
            detalle = txt.slice(0, 200);
          }
        } catch { /* ignore body read errors */ }
        throw new Error(`La API de la IA respondió con error (${response.status}): ${detalle}`);
      }

      // Response del proxy /api/claude: { content: Array<{ type, text? }> }
      // (forma de la API de Anthropic Messages). Tipado mínimo con shape
      // que solo necesita .text. Anthropic puede devolver también
      // { error: {...} } con status 200 si el modelo rechazó el contenido.
      const data: { content?: Array<{ text?: string }>; error?: { message?: string; type?: string } } = await response.json();
      if (data.error) throw new Error(`La IA rechazó la solicitud: ${data.error.message || data.error.type || 'error'}`);
      const text=data.content?.map(c => c.text || "").join("") || "";
      if (!text.trim()) throw new Error('La IA respondió vacío. Probá con otra foto o intentalo de nuevo.');
      const clean=text.replace(/```json|```/g,"").trim();
      let parsed: IAFacturaResponse;
      try { parsed = JSON.parse(clean); }
      catch { throw new Error('La IA devolvió texto no-JSON (formato inesperado). Probá con otra foto. Detalle completo en la consola.'); }

      // Defensa en profundidad (bug #41 escalada): la IA puede alucinar
      // montos completos, no solo multiplicar por 100. Tres chequeos:
      //  1. Magnitud: monto absoluto >10M ARS para una factura de gastronomía
      //     ya es excepción — vale la pena interrumpir aunque sea legítimo.
      //  2. Coherencia items: total >> suma de items implica alucinación.
      //  3. Coherencia desglose: neto+iva+percepciones >> total implica que
      //     uno de los componentes está inflado x100.
      const MAX_MONTO_RAZONABLE=10_000_000; // 10M ARS — ↓ desde 100M (bug #41)
      const camposMonto: (keyof IAFacturaResponse)[] = ["neto_gravado","iva_21","iva_105","percepciones_iibb","percepciones_iva","total"];
      const sospechososMagnitud=camposMonto.filter(c=>Number(parsed[c] || 0) > MAX_MONTO_RAZONABLE);
      const total=Number(parsed.total||0);
      const sumaItems=Array.isArray(parsed.items)?parsed.items.reduce((s, it) => s + Number(it.subtotal || 0), 0) : 0;
      const sumaDesglose=Number(parsed.neto_gravado||0)+Number(parsed.iva_21||0)+Number(parsed.iva_105||0)+Number(parsed.percepciones_iibb||0)+Number(parsed.percepciones_iva||0);
      const incoherenciaItems=sumaItems>0&&total>0&&total>sumaItems*2;
      const incoherenciaDesglose=total>0&&sumaDesglose>total*1.5;
      if(sospechososMagnitud.length>0||incoherenciaItems||incoherenciaDesglose){
        const lineas=[
          "⚠ La IA devolvió montos sospechosos:",
          "",
          ...sospechososMagnitud.map(c => "  • " + c + " excede $10M: $" + Number(parsed[c]).toLocaleString("es-AR")),
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
      // IIBB: si la IA dio el desglose por jurisdicción, usar eso. Si solo
      // dio el total agregado (compat hacia atrás), va a iibb_otros sin
      // jurisdicción (el usuario re-asigna manual después).
      const iibbCaba = parseMonto(parsed.iibb_caba);
      const iibbBa = parseMonto(parsed.iibb_ba);
      const iibbOtrosIA = parseMonto(parsed.iibb_otros);
      const iibbAgregado = parseMonto(parsed.percepciones_iibb);
      const iibbDesgloseSum = iibbCaba + iibbBa + iibbOtrosIA;
      const iibbOtrosFinal = iibbDesgloseSum > 0
        ? iibbOtrosIA
        : iibbAgregado; // fallback: si IA no discriminó, todo va a "otros"
      setForm(f=>({
        ...f,
        prov_id: provMatch ? String(provMatch.id) : "",
        nro:parsed.nro_factura||"",
        fecha:parsed.fecha_emision||"",
        venc:parsed.fecha_vencimiento||"",
        neto:parseMonto(parsed.neto_gravado),
        iva21:parseMonto(parsed.iva_21),
        iva105:parseMonto(parsed.iva_105),
        // legacy iibb plano = suma para que el total cierre
        iibb: iibbCaba + iibbBa + iibbOtrosFinal,
        perc_iva: parseMonto(parsed.percepciones_iva),
        total:parseMonto(parsed.total),
        cat:provMatch?.cat||"",
        // discriminación fiscal ampliada
        iva27: parseMonto(parsed.iva_27),
        no_gravado: parseMonto(parsed.no_gravado),
        exento: parseMonto(parsed.exento),
        iibb_caba: iibbCaba,
        iibb_ba: iibbBa,
        iibb_otros: iibbOtrosFinal,
        iibb_otros_jurisdiccion: parsed.iibb_otros_jurisdiccion || "",
        perc_ganancias: parseMonto(parsed.perc_ganancias),
        retencion_suss: parseMonto(parsed.retencion_suss),
      }));
    }catch(err){
      const msg = err instanceof Error ? err.message : String(err);
      showError("No se pudo leer la factura. " + msg);
      console.error('[LectorFacturasIA] error en leerConIA:', err);
    }
    setLoading(false);
  };

  const guardandoRef = useRef(false);
  const guardar=async()=>{
    if(guardandoRef.current)return;
    if(!form.prov_id&&!form.local_id){showError("Seleccioná el proveedor y el local antes de guardar.");return;}
    if(!form.prov_id){showError("Seleccioná el proveedor antes de guardar.");return;}
    if(!form.local_id){showError("Seleccioná el local antes de guardar.");return;}
    if(!form.nro){showError("Completá el número de factura.");return;}

    // Check FUERTE por número exacto (caso 10-jun: factura EL CRIOLLO
    // 0009-00693518 cargada 3 veces — el aviso blando de abajo fue
    // aceptado sin leer). Mismo nro + mismo proveedor = misma factura,
    // sin ambigüedad. Mensaje contundente con el estado actual y
    // contraste explícito con el total/fecha del form para detectar
    // errores de lectura de la IA (Lucas 10-jun: facturas Quilmes
    // 02747734/02747701 que la IA leía como 02743412 — el aviso
    // mostraba el mismo nro 2 veces sin permitir comparar).
    if (form.nro && form.prov_id) {
      // eslint-disable-next-line pase-local/require-apply-local-scope -- dup check cross-local intencional
      const { data: mismoNro } = await db.from("facturas")
        .select("nro, fecha, total, estado")
        .eq("prov_id", parseInt(form.prov_id))
        .eq("nro", form.nro)
        .neq("estado", "anulada")
        .limit(1);
      if (mismoNro && mismoNro.length > 0) {
        const d = mismoNro[0]!;
        const dTotal = Number(d.total) || 0;
        const fTotal = parseMonto(form.total);
        const totalCoincide = fTotal > 0 && Math.abs(dTotal - fTotal) <= Math.max(1, dTotal * 0.005);
        const fechaCoincide = !!form.fecha && d.fecha === form.fecha;
        const ok = confirm(
          `⚠️ FACTURA DUPLICADA ⚠️\n\n` +
          `Estás cargando:\n` +
          `  Nº ${form.nro}\n` +
          `  ${form.fecha ? fmt_d(form.fecha) : "(sin fecha)"} · ${fTotal > 0 ? fmt_$(fTotal) : "(sin total)"}\n\n` +
          `Ya existe con ese mismo Nº:\n` +
          `  Nº ${d.nro}\n` +
          `  ${d.fecha ? fmt_d(d.fecha) : "?"} · ${fmt_$(dTotal)} · estado: ${String(d.estado).toUpperCase()}\n\n` +
          (totalCoincide && fechaCoincide
            ? `Coinciden Nº, fecha y total → es la MISMA factura. Cargarla de nuevo DUPLICA el gasto.\n\n¿Cancelar la carga? (OK = cargar igual)`
            : `OJO: el total ${totalCoincide ? "coincide" : "NO coincide"} y la fecha ${fechaCoincide ? "coincide" : "NO coincide"}.\n` +
              `Si NO COINCIDEN total o fecha, probablemente la IA leyó MAL el número del recibo y matcheó con una factura vieja.\n\n` +
              `Mirá el recibo: si el Nº ${form.nro} NO es el que ves impreso, cancelá y corregí el Nº a mano.\n\n` +
              `¿Cargar igual (es otra factura con el mismo Nº)?`),
        );
        if (!ok) return;
      }
    }

    // Warning de duplicados (bug #29): mismo flow que Compras.tsx. Prev fecha
    // y total del form detectado por IA + confirmado por usuario.
    const totalForm = parseMonto(form.total);
    if (form.fecha && form.prov_id && totalForm > 0) {
      // eslint-disable-next-line pase-local/require-apply-local-scope -- dup check cross-local intencional: detecta misma factura cargada por error en otra sucursal del mismo proveedor. RLS limita el set al tenant del caller.
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

    guardandoRef.current = true;
    setGuardando(true);
    try {
      const id=genId("FACT");
      let imagen_url=null;
      if(archivo){
        const ext=(archivo.name.split(".").pop()||"bin").toLowerCase();
        // AUDIT F2C #4: prefijo tenant_id obligatorio por Storage RLS.
        // Sin esto, tenants nuevos no pueden subir (RLS rechaza) y el
        // fallback legacy abre los archivos a Neko. Superadmin sin tenant
        // usa "superadmin" como bucket virtual.
        const tenantPath = user.tenant_id ?? "superadmin";
        const path=`${tenantPath}/${id}.${ext}`;
        const {error:upErr}=await db.storage.from("facturas").upload(path,archivo,{contentType:archivo.type||"application/octet-stream",upsert:false});
        if(upErr){
          showError("Error subiendo la imagen: "+upErr.message);
          return;
        }
        imagen_url=path;
      }

      const confGlobal=resultado?.confianza_global??100;
      const estado=confGlobal<70?"revision":"pendiente";
      // IIBB legacy = cache de las 3 jurisdicciones (compat con queries
      // que aún leen el campo plano).
      const iibbCacheTotal =
        parseMonto(form.iibb_caba) + parseMonto(form.iibb_ba) + parseMonto(form.iibb_otros);
      const nueva = {
        ...form, id,
        prov_id: parseInt(form.prov_id), local_id: parseInt(String(form.local_id)),
        neto: parseMonto(form.neto),
        iva21: parseMonto(form.iva21), iva105: parseMonto(form.iva105),
        iva27: parseMonto(form.iva27),
        no_gravado: parseMonto(form.no_gravado), exento: parseMonto(form.exento),
        iibb: iibbCacheTotal,
        iibb_caba: parseMonto(form.iibb_caba),
        iibb_ba: parseMonto(form.iibb_ba),
        iibb_otros: parseMonto(form.iibb_otros),
        iibb_otros_jurisdiccion: form.iibb_otros_jurisdiccion.trim() || null,
        perc_iva: parseMonto(form.perc_iva),
        perc_ganancias: parseMonto(form.perc_ganancias),
        retencion_suss: parseMonto(form.retencion_suss),
        total: parseMonto(form.total),
        estado, pagos: [], imagen_url,
        fecha: form.fecha || null, venc: form.venc || null,
        tipo: "factura",
      };
      const {error:insErr} = await db.rpc("crear_factura_completa", {
        p_factura: nueva,
        p_items: [],
        p_idempotency_key: crypto.randomUUID(),
      });
      if(insErr){
        if(imagen_url) await db.storage.from("facturas").remove([imagen_url]);
        showError("Error guardando la factura: "+(insErr.message || insErr));
        return;
      }

      setArchivo(null);setPreview(null);setResultado(null);
      setForm({ ...formVacio, local_id: localActivo || "" });
      showToast("Factura cargada correctamente");
      onSaved?.();
    } finally {
      guardandoRef.current = false;
      setGuardando(false);
    }
  };

  const guardandoProvRef = useRef(false);
  const guardarProvInline = async () => {
    if (guardandoProvRef.current) return;
    if (provSaving || !provModal?.nombre) return;
    guardandoProvRef.current = true;
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
      if (error) { showError("No se pudo crear el proveedor: " + error.message); return; }
      if (data) {
        const nuevo = data as Proveedor;
        setProveedores(prev => [...prev, nuevo].sort((a, b) => (a.nombre || "").localeCompare(b.nombre || "")));
        setForm(f => ({ ...f, prov_id: String(nuevo.id), cat: nuevo.cat || f.cat }));
        setProvModal(null);
      }
    } finally {
      guardandoProvRef.current = false;
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
              type ConfKey = keyof NonNullable<IAFacturaResponse["confianza"]>;
              const campoBorder = (campo: string) => {
                const c = (conf as Partial<Record<ConfKey, number>>)[campo as ConfKey];
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
                    {advertencias.map((a, i) => (
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
                      {localesDisp.map(l=><option key={l.id} value={l.id}>{l.nombre}</option>)}
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
                  {[["Neto Gravado","neto","neto_gravado"],["IVA 21%","iva21",null],["IVA 10.5%","iva105",null],["Perc. IVA","perc_iva",null]].map(([l,k,confKey])=>(
                    <div key={k as string} style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
                      <span style={{fontSize:11,color:"var(--muted2)"}}>{l}</span>
                      <input type="number" step="0.01" value={form[k as keyof typeof form] as string | number} onChange={e=>setForm({...form,[k as string]:e.target.value})}
                        style={{width:120,background:"var(--bg)",border:confKey?campoBorder(confKey as string):"1px solid var(--bd)",color:"var(--txt)",padding:"4px 8px",fontFamily:"'DM Mono',monospace",fontSize:12,borderRadius:"var(--r)",textAlign:"right"}}/>
                    </div>
                  ))}

                  {/* Discriminación fiscal AR — colapsable (Lucas 10-jun).
                      La IA pre-cargó lo que detectó; el usuario lo corrige
                      si fuese necesario. Solo se muestra el panel si la IA
                      detectó al menos uno de estos campos. */}
                  {(() => {
                    const tieneExtras =
                      Number(form.iva27) > 0 || Number(form.no_gravado) > 0 || Number(form.exento) > 0 ||
                      Number(form.iibb_caba) > 0 || Number(form.iibb_ba) > 0 || Number(form.iibb_otros) > 0 ||
                      Number(form.perc_ganancias) > 0 || Number(form.retencion_suss) > 0;
                    return (
                      <details open={tieneExtras} style={{ margin: "8px 0", padding: "6px 8px", border: "0.5px solid var(--bd)", borderRadius: "var(--r)" }}>
                        <summary style={{ cursor: "pointer", fontSize: 11, color: "var(--muted2)", fontWeight: 500 }}>
                          Discriminación fiscal {tieneExtras ? "✓ IA detectó" : "(opcional)"}
                        </summary>
                        <div style={{ marginTop: 8 }}>
                          {[
                            ["IVA 27%","iva27"],
                            ["No gravado","no_gravado"],
                            ["Exento","exento"],
                            ["IIBB · CABA","iibb_caba"],
                            ["IIBB · Bs As","iibb_ba"],
                            ["IIBB · Otra","iibb_otros"],
                            ["Perc. Ganancias","perc_ganancias"],
                            ["Retención SUSS","retencion_suss"],
                          ].map(([l,k]) => (
                            <div key={k as string} style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:4}}>
                              <span style={{fontSize:11,color:"var(--muted2)"}}>{l}</span>
                              <input type="number" step="0.01" value={form[k as keyof typeof form] as string | number} onChange={e=>setForm({...form,[k as string]:e.target.value})}
                                style={{width:120,background:"var(--bg)",border: "0.5px solid var(--bd)",color:"var(--txt)",padding:"3px 6px",fontFamily:"'DM Mono',monospace",fontSize:11,borderRadius:"var(--r)",textAlign:"right"}}/>
                            </div>
                          ))}
                          {Number(form.iibb_otros) > 0 && (
                            <div style={{ marginTop: 6 }}>
                              <input type="text" placeholder="Jurisdicción del IIBB otra (Córdoba, Mendoza…)"
                                value={form.iibb_otros_jurisdiccion}
                                onChange={e=>setForm({...form,iibb_otros_jurisdiccion: e.target.value})}
                                style={{width:"100%",background:"var(--bg)",border: "0.5px solid var(--bd)",color:"var(--txt)",padding:"3px 6px",fontSize:11,borderRadius:"var(--r)"}}/>
                            </div>
                          )}
                        </div>
                      </details>
                    );
                  })()}

                  <div style={{display:"flex",justifyContent:"space-between",borderTop: "0.5px solid var(--bd)",paddingTop:8}}>
                    <span style={{fontWeight:500}}>TOTAL</span>
                    <input type="number" step="0.01" value={form.total} onChange={e=>setForm({...form,total:e.target.value})}
                      style={{width:120,background:"var(--bg)",border:conf.total!==undefined&&conf.total<80?campoBorder("total"):"1px solid var(--acc)",color:"var(--acc)",padding:"4px 8px",fontFamily:"'Inter',sans-serif",fontWeight:500,fontSize:14,borderRadius:"var(--r)",textAlign:"right"}}/>
                  </div>
                </div>

                {(resultado.items?.length ?? 0) > 0 && (() => {
                  // Bug #41 capa 3: si la suma de items no coincide con
                  // el neto detectado, mostrar warning sobre los ítems.
                  // Tolerancia 5% — los ítems típicos no incluyen IVA pero
                  // sí descuentos/redondeos chicos. Si la diferencia es mayor,
                  // probable alucinación o lectura incompleta.
                  const items = resultado.items ?? [];
                  const sumaItems = items.reduce((s, it) => s + Number(it.subtotal || 0), 0);
                  const netoDet=parseMonto(form.neto);
                  const diff=netoDet>0?Math.abs(sumaItems-netoDet)/netoDet:0;
                  const incoherente=netoDet>0&&sumaItems>0&&diff>0.05;
                  return (
                    <div style={{marginBottom:12}}>
                      <div style={{fontSize:9,letterSpacing:2,textTransform: "none",color:"var(--muted)",marginBottom:8}}>Ítems detectados ({items.length})</div>
                      {incoherente&&(
                        <div className="alert alert-danger" style={{marginBottom:8,fontSize:11}}>
                          ⚠ Los items no suman al neto detectado — revisá manualmente. Suma items: <strong>{fmt_$(sumaItems)}</strong> vs neto: <strong>{fmt_$(netoDet)}</strong>.
                        </div>
                      )}
                      {items.map((it, i) => (
                        <div key={i} style={{display:"flex",justifyContent:"space-between",padding:"6px 0",borderBottom: "0.5px solid var(--bd)",fontSize:11}}>
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

      {/* AUDIT F4B#1 / sprint #5: migrado a <Modal> compartido. */}
      <Modal
        isOpen={!!provModal}
        onClose={()=>setProvModal(null)}
        title="Nuevo proveedor"
        maxWidth={480}
        preventCloseOnOverlay={provSaving}
        footer={
          <>
            <button className="btn btn-sec" onClick={()=>setProvModal(null)}>Cancelar</button>
            <button className="btn btn-acc" onClick={guardarProvInline} disabled={provSaving||!provModal?.nombre}>
              {provSaving?"Guardando...":"Crear y seleccionar"}
            </button>
          </>
        }
      >
        {provModal && (
          <>
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
          </>
        )}
      </Modal>

      <ToastComponent toast={toast} />
    </div>
  );
}