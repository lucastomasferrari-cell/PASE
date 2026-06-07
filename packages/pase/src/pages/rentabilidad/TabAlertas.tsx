// Tab Alertas: bandeja unificada de problemas de rentabilidad
//
// Lo que junta:
//   1. Brecha de eficiencia post-conteo: conteos cerrados con diferencia
//      negativa significativa sin mermas que la justifiquen.
//   2. Margen erosionado: alertas que genera el trigger trg_recosting_alerta_margen
//      cuando un proveedor sube un precio y un plato cae >5pp.
//   3. Stock por quebrar: insumos con stock_actual < stock_minimo (días
//      restantes según consumo).
//
// Read-only. Cada alerta tiene un estado "reconocida" para que el dueño
// las pueda ir cerrando.

import { useState, useEffect } from "react";
import { db } from "../../lib/supabase";
import { applyLocalScope } from "../../lib/auth";
import { fmt_$, fmt_d } from "@pase/shared/utils";
import { EmptyState } from "../../components/ui";
import type { Usuario, Local } from "../../types";

interface Props {
  user: Usuario;
  locales: Local[];
  localActivo: number | null;
}

interface AlertaMargen {
  id: number;
  item_id: number;
  receta_id: number;
  trigger_insumo_id: number;
  precio_actual: number;
  costo_anterior: number;
  costo_nuevo: number;
  margen_anterior_pct: number;
  margen_nuevo_pct: number;
  caida_pp: number;
  reconocida_at: string | null;
  created_at: string;
  // Joineados
  item_nombre?: string;
  insumo_nombre?: string;
}

interface ConteoConBrecha {
  id: number;
  local_id: number;
  finalizado_at: string;
  valor_diferencia: number;
  cant_insumos: number;
  estado: string;
}

interface StockQuebrar {
  id: number;
  nombre: string;
  unidad: string;
  local_id: number | null;
  stock_actual: number;
  stock_minimo: number;
  costo_actual: number | null;
}

export function TabAlertas({ user, locales, localActivo }: Props) {
  const [alertasMargen, setAlertasMargen] = useState<AlertaMargen[]>([]);
  const [conteosConBrecha, setConteosConBrecha] = useState<ConteoConBrecha[]>([]);
  const [stockQuebrar, setStockQuebrar] = useState<StockQuebrar[]>([]);
  const [loading, setLoading] = useState(true);
  const [filtroEstado, setFiltroEstado] = useState<"abiertas" | "todas">("abiertas");

  const cargar = async () => {
    setLoading(true);

    // 1. Alertas de margen erosionado
    let qMargen = db.from("recetas_alertas_margen")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(50);
    if (filtroEstado === "abiertas") {
      qMargen = qMargen.is("reconocida_at", null);
    }
    const { data: alMargen } = await qMargen;

    // Joinear nombres
    const alertas = (alMargen as AlertaMargen[]) || [];
    if (alertas.length > 0) {
      const itemIds = Array.from(new Set(alertas.map(a => a.item_id)));
      const insumoIds = Array.from(new Set(alertas.map(a => a.trigger_insumo_id)));
      const [{ data: items }, { data: insumos }] = await Promise.all([
        db.from("items").select("id, nombre").in("id", itemIds),
        db.from("insumos").select("id, nombre").in("id", insumoIds),
      ]);
      const itemsMap = new Map((items || []).map((i: { id: number; nombre: string }) => [i.id, i.nombre]));
      const insumosMap = new Map((insumos || []).map((i: { id: number; nombre: string }) => [i.id, i.nombre]));
      alertas.forEach(a => {
        a.item_nombre = itemsMap.get(a.item_id);
        a.insumo_nombre = insumosMap.get(a.trigger_insumo_id);
      });
    }
    setAlertasMargen(alertas);

    // 2. Conteos cerrados con brecha negativa significativa (>$1000 o equivalente)
    let qConteos = db.from("stock_conteos")
      .select("id, local_id, finalizado_at, valor_diferencia, estado")
      .eq("estado", "finalizado")
      .order("finalizado_at", { ascending: false })
      .limit(20);
    qConteos = applyLocalScope(qConteos, user, localActivo);
    const { data: conteos } = await qConteos;
    setConteosConBrecha(((conteos || []) as ConteoConBrecha[]).filter(c => Number(c.valor_diferencia) < -100));

    // 3. Stock por quebrar (stock_actual < stock_minimo)
    let qStock = db.from("insumos")
      .select("id, nombre, unidad, local_id, stock_actual, stock_minimo, costo_actual")
      .eq("activo", true)
      .is("deleted_at", null)
      .not("stock_minimo", "is", null);
    qStock = applyLocalScope(qStock, user, localActivo);
    const { data: stockRaw } = await qStock;
    const stockBajo = ((stockRaw || []) as StockQuebrar[])
      .filter(i => Number(i.stock_actual ?? 0) < Number(i.stock_minimo))
      .sort((a, b) => {
        // Más críticos arriba (stock más cerca de 0 relativamente)
        const ratioA = Number(a.stock_actual ?? 0) / Math.max(Number(a.stock_minimo), 0.01);
        const ratioB = Number(b.stock_actual ?? 0) / Math.max(Number(b.stock_minimo), 0.01);
        return ratioA - ratioB;
      });
    setStockQuebrar(stockBajo);

    setLoading(false);
  };

  useEffect(() => { void cargar(); }, [user, localActivo, filtroEstado]);

  const reconocer = async (id: number) => {
    await db.from("recetas_alertas_margen")
      .update({ reconocida_at: new Date().toISOString(), reconocida_por: user.id })
      .eq("id", id);
    await cargar();
  };

  const totalAlertas = alertasMargen.filter(a => !a.reconocida_at).length + conteosConBrecha.length + stockQuebrar.length;
  const localNombre = (id: number | null) => id == null ? "—" : (locales.find(l => l.id === id)?.nombre || `#${id}`);

  return (
    <div>
      {/* ─── Filtro ─── */}
      <div style={{ display: "flex", gap: 8, marginBottom: 16, alignItems: "center" }}>
        <button
          onClick={() => setFiltroEstado("abiertas")}
          className={`btn ${filtroEstado === "abiertas" ? "btn-acc" : "btn-ghost"} btn-sm`}
        >
          Solo abiertas ({totalAlertas})
        </button>
        <button
          onClick={() => setFiltroEstado("todas")}
          className={`btn ${filtroEstado === "todas" ? "btn-acc" : "btn-ghost"} btn-sm`}
        >
          Todas
        </button>
      </div>

      {loading ? (
        <div className="loading">Cargando alertas...</div>
      ) : totalAlertas === 0 && filtroEstado === "abiertas" ? (
        <EmptyState
          icon="✅"
          title="Todo bajo control"
          description="No hay alertas abiertas. Cuando un proveedor suba un precio, un conteo cierre con diferencia o un insumo quede bajo el mínimo, vas a verlo acá."
        />
      ) : (
        <>
          {/* ─── 1. Margen erosionado ─── */}
          {alertasMargen.length > 0 && (
            <div className="panel" style={{ marginBottom: 16 }}>
              <div className="panel-hd">
                <span className="panel-title">
                  📉 Margen erosionado ({alertasMargen.filter(a => !a.reconocida_at).length} sin atender)
                </span>
              </div>
              <div className="table-scroll-wrap">
                <table style={{ minWidth: 720 }}>
                  <thead>
                    <tr>
                      <th>Plato</th>
                      <th>Insumo que subió</th>
                      <th className="num-right">Costo antes</th>
                      <th className="num-right">Costo ahora</th>
                      <th className="num-right">Margen antes</th>
                      <th className="num-right">Margen ahora</th>
                      <th className="num-right">Caída</th>
                      <th>Estado</th>
                    </tr>
                  </thead>
                  <tbody>
                    {alertasMargen.map(a => (
                      <tr key={a.id} style={{ opacity: a.reconocida_at ? 0.5 : 1 }}>
                        <td style={{ fontWeight: 500 }}>{a.item_nombre || `Item #${a.item_id}`}</td>
                        <td style={{ fontSize: 11 }}>{a.insumo_nombre || `Insumo #${a.trigger_insumo_id}`}</td>
                        <td className="num-right mono">{fmt_$(a.costo_anterior)}</td>
                        <td className="num-right mono" style={{ color: "var(--warn)" }}>{fmt_$(a.costo_nuevo)}</td>
                        <td className="num-right mono">{Number(a.margen_anterior_pct).toFixed(1)}%</td>
                        <td className="num-right mono" style={{ color: a.margen_nuevo_pct < 0 ? "var(--danger)" : undefined }}>
                          {Number(a.margen_nuevo_pct).toFixed(1)}%
                        </td>
                        <td className="num-right mono" style={{ color: "var(--danger)", fontWeight: 500 }}>
                          −{Number(a.caida_pp).toFixed(1)} pp
                        </td>
                        <td>
                          {a.reconocida_at ? (
                            <span className="badge b-muted" style={{ fontSize: 10 }}>Reconocida</span>
                          ) : (
                            <button className="btn btn-ghost btn-sm" onClick={() => reconocer(a.id)}>
                              Reconocer
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ─── 2. Brechas de eficiencia post-conteo ─── */}
          {conteosConBrecha.length > 0 && (
            <div className="panel" style={{ marginBottom: 16 }}>
              <div className="panel-hd">
                <span className="panel-title">⚠ Posible fuga en conteos cerrados ({conteosConBrecha.length})</span>
              </div>
              <div className="table-scroll-wrap">
                <table style={{ minWidth: 600 }}>
                  <thead>
                    <tr>
                      <th>Local</th>
                      <th>Fecha cierre</th>
                      <th className="num-right">Diferencia $</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {conteosConBrecha.map(c => (
                      <tr key={c.id}>
                        <td>{localNombre(c.local_id)}</td>
                        <td className="mono" style={{ fontSize: 11 }}>{fmt_d(c.finalizado_at?.slice(0, 10) || "")}</td>
                        <td className="num-right mono" style={{ color: "var(--danger)", fontWeight: 500 }}>
                          {fmt_$(c.valor_diferencia)}
                        </td>
                        <td style={{ fontSize: 11, color: "var(--muted2)" }}>
                          Diferencia negativa sin mermas que la justifiquen
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ─── 3. Stock por quebrar ─── */}
          {stockQuebrar.length > 0 && (
            <div className="panel" style={{ marginBottom: 16 }}>
              <div className="panel-hd">
                <span className="panel-title">📦 Stock por quebrar ({stockQuebrar.length})</span>
              </div>
              <div className="table-scroll-wrap">
                <table style={{ minWidth: 600 }}>
                  <thead>
                    <tr>
                      <th>Insumo</th>
                      <th>Local</th>
                      <th className="num-right">Stock</th>
                      <th className="num-right">Mínimo</th>
                      <th className="num-right">Valor faltante</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stockQuebrar.map(i => {
                      const faltante = Math.max(0, Number(i.stock_minimo) - Number(i.stock_actual ?? 0));
                      const valorFaltante = faltante * Number(i.costo_actual ?? 0);
                      return (
                        <tr key={i.id}>
                          <td style={{ fontWeight: 500 }}>{i.nombre}</td>
                          <td style={{ fontSize: 11 }}>{localNombre(i.local_id)}</td>
                          <td className="num-right mono" style={{ color: Number(i.stock_actual ?? 0) === 0 ? "var(--danger)" : "var(--warn)" }}>
                            {Number(i.stock_actual ?? 0).toFixed(2)} {i.unidad}
                          </td>
                          <td className="num-right mono" style={{ fontSize: 11 }}>
                            {Number(i.stock_minimo).toFixed(2)} {i.unidad}
                          </td>
                          <td className="num-right mono">{fmt_$(valorFaltante)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
