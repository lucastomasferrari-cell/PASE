// ─── CRUCE MATERIA PRIMA → INSUMO ─────────────────────────────────────────
// Bandeja "insumo-first": los productos de facturas (mercadería CMV) que el
// sistema no reconoció aparecen acá para cruzarlos con su INSUMO en un paso.
// Al cruzar se crea la materia prima (ya con su insumo — nunca huérfana),
// se vinculan todos los renglones de ese producto y el sistema lo recuerda
// (compras_mapeo). El trigger de stock suma el insumo y recalcula el costo.
//
// Diferencia con Conciliación: acá elegís el INSUMO directo (con sugerencia
// por nombre + aceptar de un click); la materia prima se arma sola con
// valores por defecto (factor 1, unidad del renglón). Los detalles finos de
// la MP se editan después en Materias primas.
//
// Reusa el backend de la bandeja: v_bandeja_conciliacion + fn_conciliar_producto
// + fn_descartar_renglon. Sin RPC nueva.

import { useState, useEffect, useMemo, useRef } from "react";
import { db } from "../lib/supabase";
import { tienePermiso } from "../lib/auth";
import { useGuardedHandler } from "../lib/useGuardedHandler";
import { translateRpcError } from "../lib/errors";
import { fmt_$ } from "@pase/shared/utils";
import type { Usuario, Local } from "../types/auth";
import { useToast } from "../hooks/useToast";
import { ToastComponent } from "../components/Toast";

interface BandejaRow {
  factura_item_id: number;
  factura_id: string;
  producto: string;
  cantidad: number;
  unidad: string;
  precio_unitario: number | null;
  proveedor_id: number | null;
  proveedor_nombre: string | null;
  factura_fecha: string;
  texto_norm: string;
  sugerencia_mp_id: number | null;
}

interface MateriaPrima { id: number; nombre: string; proveedor_id: number | null; insumo_id: number; }
interface Insumo { id: number; nombre: string; unidad: string; }

interface Grupo {
  key: string;
  producto: string;
  texto_norm: string;
  unidad: string;
  proveedor_id: number | null;
  proveedor_nombre: string | null;
  sugerencia_mp_id: number | null;
  facturaItemIds: number[];
  nFacturas: number;
  ultimoPrecio: number | null;
}

interface CruceProps {
  user: Usuario;
  locales?: Local[];
  localActivo: number | null;
  embedded?: boolean;
}

// Normalización simple para el matcheo por nombre (minúsculas, sin tildes).
const norm = (s: string) =>
  s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim();

// Las unidades de las facturas vienen escritas de cualquier forma ("u", "l",
// "lts"…), pero insumos.unidad y materias_primas.unidad_compra tienen un CHECK
// que solo acepta un set fijo. Mapeamos al set común válido para las dos tablas
// (kg, g, L, ml, un, porcion); cualquier cosa rara cae en "un".
const normUnidad = (u: string | null): string => {
  const s = (u ?? "").trim().toLowerCase();
  if (["kg", "kgs", "kilo", "kilos", "kilogramo", "kilogramos"].includes(s)) return "kg";
  if (["g", "gr", "grs", "gramo", "gramos"].includes(s)) return "g";
  if (["l", "lt", "lts", "litro", "litros"].includes(s)) return "L";
  if (["ml", "cc", "cm3"].includes(s)) return "ml";
  if (["porcion", "porción", "porciones"].includes(s)) return "porcion";
  return "un"; // u, unid, unidad, caja, bolsa, docena, vacío, etc.
};

export default function Cruce({ user, embedded = false }: CruceProps) {
  const { toast, showError, showToast } = useToast();
  const [rows, setRows] = useState<BandejaRow[]>([]);
  const [mps, setMps] = useState<MateriaPrima[]>([]);
  const [insumos, setInsumos] = useState<Insumo[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");

  // Fila con el picker de insumo abierto + su búsqueda + factor.
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [pickSearch, setPickSearch] = useState("");
  const [pickFactor, setPickFactor] = useState("1");
  const pickInputRef = useRef<HTMLInputElement>(null);

  const puede = tienePermiso(user, "compras") || user.rol === "dueno" || user.rol === "admin" || user.rol === "superadmin";

  const load = async () => {
    setLoading(true);
    const [bRes, mpRes, insRes] = await Promise.all([
      db.from("v_bandeja_conciliacion")
        .select("factura_item_id, factura_id, producto, cantidad, unidad, precio_unitario, proveedor_id, proveedor_nombre, factura_fecha, texto_norm, sugerencia_mp_id")
        .eq("grupo_categoria", "CMV")
        .order("factura_fecha", { ascending: false })
        .limit(2000),
      db.from("materias_primas").select("id, nombre, proveedor_id, insumo_id").is("deleted_at", null).eq("activa", true),
      db.from("insumos").select("id, nombre, unidad").eq("activo", true).is("deleted_at", null).order("nombre"),
    ]);
    if (bRes.error) { showError("No se pudo cargar la bandeja: " + bRes.error.message); setLoading(false); return; }
    setRows((bRes.data || []) as BandejaRow[]);
    setMps((mpRes.data || []) as MateriaPrima[]);
    setInsumos((insRes.data || []) as Insumo[]);
    setLoading(false);
  };

  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const insById = useMemo(() => { const m = new Map<number, Insumo>(); insumos.forEach(i => m.set(i.id, i)); return m; }, [insumos]);
  const mpById = useMemo(() => { const m = new Map<number, MateriaPrima>(); mps.forEach(p => m.set(p.id, p)); return m; }, [mps]);

  const grupos: Grupo[] = useMemo(() => {
    const map = new Map<string, Grupo & { facturas: Set<string> }>();
    for (const r of rows) {
      const key = `${r.texto_norm}||${r.proveedor_id ?? "x"}`;
      let g = map.get(key);
      if (!g) {
        g = {
          key, producto: r.producto, texto_norm: r.texto_norm, unidad: r.unidad || "un",
          proveedor_id: r.proveedor_id, proveedor_nombre: r.proveedor_nombre,
          sugerencia_mp_id: r.sugerencia_mp_id,
          facturaItemIds: [], nFacturas: 0,
          ultimoPrecio: r.precio_unitario != null ? Number(r.precio_unitario) : null,
          facturas: new Set<string>(),
        };
        map.set(key, g);
      }
      g.facturaItemIds.push(r.factura_item_id);
      g.facturas.add(r.factura_id);
    }
    return [...map.values()]
      .map(g => ({ ...g, nFacturas: g.facturas.size }))
      .filter(g => !search || g.producto.toLowerCase().includes(search.toLowerCase()))
      .sort((a, b) => a.producto.localeCompare(b.producto));
  }, [rows, search]);

  // Insumo sugerido: primero el insumo de la MP sugerida por el backend; si no,
  // match por nombre (el nombre del insumo aparece dentro del producto o viceversa).
  const sugerirInsumo = (g: Grupo): Insumo | null => {
    if (g.sugerencia_mp_id) {
      const mp = mpById.get(g.sugerencia_mp_id);
      const ins = mp ? insById.get(mp.insumo_id) : null;
      if (ins) return ins;
    }
    const p = norm(g.producto);
    let best: Insumo | null = null;
    let bestLen = 0;
    for (const ins of insumos) {
      const n = norm(ins.nombre);
      if (n.length < 3) continue;
      if ((p.includes(n) || n.includes(p)) && n.length > bestLen) { best = ins; bestLen = n.length; }
    }
    return best;
  };

  // Cruza el producto con un insumo: crea la materia prima (con su insumo) y
  // vincula todos los renglones vía fn_conciliar_producto.
  const { run: matchear, isPending: matcheando } = useGuardedHandler(async (g: Grupo, insumoId: number, factor: number) => {
    const { data: mp, error: mpErr } = await db.from("materias_primas").insert([{
      tenant_id: user.tenant_id, created_by: user.id,
      nombre: g.producto,
      proveedor_id: g.proveedor_id,
      insumo_id: insumoId,
      unidad_compra: normUnidad(g.unidad),
      factor_conversion: factor > 0 ? factor : 1,
      precio_actual: g.ultimoPrecio,
      activa: true,
      ...(g.ultimoPrecio != null ? { precio_actualizado_at: new Date().toISOString() } : {}),
    }]).select("id").single();
    if (mpErr || !mp) { showError("No se pudo crear la materia prima: " + (mpErr?.message ?? "vacío")); return; }

    const { data: res, error: cErr } = await db.rpc("fn_conciliar_producto", {
      p_materia_prima_id: mp.id,
      p_producto: g.producto,
      p_proveedor_id: g.proveedor_id,
      p_global: false,
      p_idempotency_key: null,
    });
    if (cErr) { showError("No se pudo cruzar: " + translateRpcError(cErr)); return; }
    const n = (res as { renglones_vinculados?: number })?.renglones_vinculados ?? 0;
    const ins = insById.get(insumoId);
    showToast(`${g.producto} → ${ins?.nombre ?? "insumo"} · ${n} renglón${n === 1 ? "" : "es"} vinculado${n === 1 ? "" : "s"}`);
    setOpenKey(null);
    await load();
  });

  const { run: noVaAReceta, isPending: descartando } = useGuardedHandler(async (g: Grupo) => {
    if (!confirm(`"${g.producto}" no va a receta (limpieza, envases, flete…). Se saca de la bandeja y no vuelve. ¿Confirmás?`)) return;
    for (const id of g.facturaItemIds) {
      const { error } = await db.rpc("fn_descartar_renglon", { p_factura_item_id: id, p_descartar: true });
      if (error) { showError("No se pudo clasificar: " + translateRpcError(error)); return; }
    }
    showToast("Marcado como no-receta");
    await load();
  });

  const { run: crearInsumoYMatch, isPending: creandoInsumo } = useGuardedHandler(async (g: Grupo, nombre: string, factor: number) => {
    const { data, error } = await db.from("insumos").insert([{
      tenant_id: user.tenant_id, created_by: user.id,
      nombre: nombre.trim(), unidad: normUnidad(g.unidad),
      activo: true, es_comprado: true, stock_disponible: true,
    }]).select("id").single();
    if (error || !data) { showError("No se pudo crear el insumo: " + (error?.message ?? "vacío")); return; }
    await matchear(g, data.id as number, factor);
  });

  const abrirPicker = (g: Grupo) => {
    setOpenKey(g.key);
    setPickSearch("");
    setPickFactor("1");
  };

  const total = grupos.length;

  return (
    <div>
      <ToastComponent toast={toast} />
      {!embedded && (
        <div className="ph-row">
          <div>
            <div className="ph-title">Cruce materia prima → insumo</div>
            <div style={{ color: "var(--muted2)", fontSize: 12, marginTop: 2 }}>
              Asigná el insumo a cada producto de factura pendiente · {total} sin matchear
            </div>
          </div>
        </div>
      )}

      {/* Toolbar */}
      {rows.length > 0 && (
        <div className="panel" style={{ marginBottom: 8 }}>
          <div style={{ padding: "10px 14px", display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center" }}>
            <input type="text" placeholder="Buscar producto…" value={search} onChange={e => setSearch(e.target.value)} className="search" style={{ flex: 1, minWidth: 180 }} />
            <span className="badge b-warn" style={{ fontSize: 11 }}>{total} sin matchear</span>
          </div>
        </div>
      )}

      {/* Lista */}
      {loading ? (
        <div className="panel"><div className="loading" style={{ padding: 40 }}>Cargando bandeja…</div></div>
      ) : grupos.length === 0 ? (
        <div className="panel" style={{ padding: "48px 24px", textAlign: "center" }}>
          <div style={{ fontSize: 15, fontWeight: 500, color: "var(--txt)" }}>Bandeja vacía</div>
          <div style={{ fontSize: 12, color: "var(--muted2)", marginTop: 4 }}>
            Todas las materias primas tienen insumo. Cuando cargues facturas, los productos nuevos aparecen acá para cruzarlos una vez.
          </div>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {grupos.map(g => {
            const sug = sugerirInsumo(g);
            const open = openKey === g.key;
            const busy = matcheando || descartando || creandoInsumo;
            const insFiltrados = insumos.filter(i => !pickSearch || norm(i.nombre).includes(norm(pickSearch)));
            const factorNum = parseFloat(pickFactor) || 1;
            // ¿Lo que escribió coincide EXACTO con un insumo? Si no, ofrecemos crear
            // (aunque haya parecidos: "Aceite de oliva" no es "Aceite de sésamo").
            const hayExacto = insumos.some(i => norm(i.nombre) === norm(pickSearch));
            return (
              <div key={g.key} className="panel" style={{ padding: 0, ...(open ? { borderColor: "var(--acc)" } : {}) }}>
                {/* Fila principal */}
                <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 14px" }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 500, color: "var(--txt)" }}>{g.producto}</div>
                    <div style={{ fontSize: 12, color: "var(--muted2)", marginTop: 2 }}>
                      {g.proveedor_nombre || "Sin proveedor"}
                      {g.ultimoPrecio != null && <> · {fmt_$(g.ultimoPrecio)} / {g.unidad}</>}
                      {g.nFacturas > 1 && <> · {g.nFacturas} facturas</>}
                    </div>
                  </div>

                  {puede && !open && (
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      {sug && (
                        <button
                          className="btn btn-sm"
                          style={{ background: "var(--pase-celeste-100)", color: "var(--acc)", border: "0.5px solid var(--pase-celeste-300)" }}
                          disabled={busy}
                          onClick={() => matchear(g, sug.id, 1)}
                          title={`Matchear a ${sug.nombre}`}
                        >
                          ≈ {sug.nombre} · aceptar
                        </button>
                      )}
                      <button className="btn btn-acc btn-sm" disabled={busy} onClick={() => abrirPicker(g)}>Matchear</button>
                      <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => noVaAReceta(g)}>No va a receta</button>
                    </div>
                  )}
                </div>

                {/* Picker de insumo (expandido) */}
                {open && (
                  <div style={{ borderTop: "0.5px solid var(--bd)", padding: "12px 14px", background: "var(--s2)" }}>
                    <div style={{ display: "flex", gap: 8, alignItems: "flex-end", marginBottom: 10 }}>
                      <div style={{ flex: 1 }}>
                        <label style={{ fontSize: 11, color: "var(--muted2)" }}>Buscar insumo</label>
                        <input ref={pickInputRef} type="text" autoFocus value={pickSearch} onChange={e => setPickSearch(e.target.value)} className="search" style={{ width: "100%" }} placeholder="Escribí para filtrar o crear…" />
                      </div>
                      <div style={{ width: 150 }}>
                        <label style={{ fontSize: 11, color: "var(--muted2)" }}>1 {g.unidad} =</label>
                        <input type="number" step="0.01" min="0.01" value={pickFactor} onChange={e => setPickFactor(e.target.value)} className="search" style={{ width: "100%" }} />
                      </div>
                      <button className="btn btn-ghost btn-sm" onClick={() => setOpenKey(null)}>Cancelar</button>
                    </div>

                    <div style={{ maxHeight: 240, overflowY: "auto", display: "flex", flexDirection: "column", gap: 2 }}>
                      {sug && !pickSearch && (
                        <button className="cruce-opt cruce-opt-sug" disabled={busy} onClick={() => matchear(g, sug.id, factorNum)}>
                          ★ {sug.nombre} <span style={{ color: "var(--muted2)", fontSize: 11 }}>· sugerido ({sug.unidad})</span>
                        </button>
                      )}
                      {insFiltrados.filter(i => !sug || pickSearch || i.id !== sug.id).map(i => (
                        <button key={i.id} className="cruce-opt" disabled={busy} onClick={() => matchear(g, i.id, factorNum)}>
                          {i.nombre} <span style={{ color: "var(--muted2)", fontSize: 11 }}>({i.unidad})</span>
                        </button>
                      ))}
                      {/* Botón crear insumo: siempre visible. Con nombre nuevo escrito,
                          lo crea y matchea; vacío o con match exacto, enfoca el buscador. */}
                      <button
                        className="cruce-opt"
                        style={{ color: "var(--acc)", fontWeight: 500, borderTop: "0.5px solid var(--bd)", marginTop: 4, paddingTop: 10 }}
                        disabled={busy}
                        onClick={() => {
                          if (pickSearch.trim() && !hayExacto) crearInsumoYMatch(g, pickSearch, factorNum);
                          else pickInputRef.current?.focus();
                        }}
                      >
                        {pickSearch.trim() && !hayExacto
                          ? `+ Crear insumo «${pickSearch.trim()}» y matchear`
                          : "+ Crear insumo nuevo"}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
