// ─── RECETARIO ──────────────────────────────────────────────────────────────
// Hub de Catálogo de cocina: agrupa Insumos + Recetas (y futuras secciones
// como Sub-recetas / Mermas motivos / etc.) en una sola pantalla con
// sub-nav lateral derecha (mismo patrón que Compras y Caja).
//
// Sprint 28-may noche (Lucas):
//   - "insumos y recetas no deberian ir en direccion"
//   - "deberian estar los dos en el mismo coso"
//   - "Habria que crear la pagina asi como compras"
//
// La URL controla la sub-sección activa via search param ?sec=insumos|recetas
// para que sea bookmarkable y se mantenga al refrescar.
//
// Las acciones del header (Nuevo insumo, Nueva receta) se transmiten al
// componente embebido vía search param ?action=nuevo-insumo|nueva-receta
// (mismo patrón que Compras → Proveedores).

import { Suspense, lazy, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useGuardedHandler } from "../lib/useGuardedHandler";
import { db } from "../lib/supabase";
import type { Usuario, Local } from "../types/auth";
import { RightSubNav, type SubNavSection, PageHeader } from "../components/ui";

const Insumos = lazy(() => import("./Insumos"));
const Recetas = lazy(() => import("./Recetas"));
const MateriasPrimas = lazy(() => import("./MateriasPrimas"));
const Cruce = lazy(() => import("./Cruce"));
const Stock = lazy(() => import("./Stock"));

type SubSection = "insumos" | "materias-primas" | "recetas" | "cruce" | "stock";

interface RecetarioProps {
  user: Usuario;
  locales?: Local[];
  localActivo: number | null;
}

export default function Recetario({ user, locales = [], localActivo }: RecetarioProps) {
  const [searchParams, setSearchParams] = useSearchParams();
  // "conciliacion" (la pantalla vieja, reemplazada por "cruce") → redirige a cruce
  // para no romper bookmarks. Ambas leían la misma bandeja; Cruce es la nueva.
  const rawSec = searchParams.get("sec");
  const subSection: SubSection = rawSec === "conciliacion" ? "cruce" : ((rawSec as SubSection) || "insumos");

  // Contadores live para el RightSubNav
  const [counts, setCounts] = useState({ insumos: 0, recetas: 0, items: 0, sinReceta: 0, mps: 0, pendientes: 0 });

  const { run: loadCounts } = useGuardedHandler(async () => {
    const [iRes, rRes, itRes, mpRes, pRes] = await Promise.all([
      db.from("insumos").select("id", { count: "exact", head: true }).eq("activo", true).is("deleted_at", null),
      db.from("recetas").select("id", { count: "exact", head: true }).eq("activa", true).is("deleted_at", null),
      db.from("items").select("id", { count: "exact", head: true }).eq("estado", "disponible").eq("es_open_item", false).is("deleted_at", null),
      db.from("materias_primas").select("id", { count: "exact", head: true }).eq("activa", true).is("deleted_at", null),
      db.from("v_bandeja_conciliacion").select("factura_item_id", { count: "exact", head: true }).eq("grupo_categoria", "CMV"),
    ]);
    setCounts({
      insumos: iRes.count ?? 0,
      recetas: rRes.count ?? 0,
      items: itRes.count ?? 0,
      sinReceta: (itRes.count ?? 0) - (rRes.count ?? 0),
      mps: mpRes.count ?? 0,
      pendientes: pRes.count ?? 0,
    });
  });

  useEffect(() => {
    void loadCounts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setSubSection = (sec: SubSection) => {
    const next = new URLSearchParams(searchParams);
    next.set("sec", sec);
    next.delete("action"); // si veníamos de un action pendiente, limpiar
    setSearchParams(next, { replace: true });
  };

  const triggerAction = (action: string) => {
    const next = new URLSearchParams(searchParams);
    next.set("action", action);
    setSearchParams(next, { replace: true });
  };

  // Header del hub: título dinámico según sub-sección + botón contextual de "Nuevo".
  const subTitle: Record<SubSection, string> = {
    insumos: "insumos",
    "materias-primas": "materias primas",
    recetas: "recetas",
    cruce: "cruce",
    stock: "stock",
  };
  const sub = subTitle[subSection];

  const subDescriptions: Record<SubSection, string> = {
    insumos: "Catálogo de materia prima usado por recetas, stock y mermas.",
    "materias-primas": "Catálogo de \"qué te vende cada proveedor\" — vincula proveedor → unidad de compra → insumo. Necesario para que las facturas sumen stock automático.",
    recetas: "Vinculá items vendibles con sus ingredientes para calcular CMV y descontar stock al vender.",
    cruce: "Asigná el insumo a cada producto de factura pendiente. Al cruzar se crea la materia prima con su insumo y el sistema lo recuerda.",
    stock: "Stock actual, conteos ciegos (cargás lo contado sin ver el teórico → diferencia real), y mermas.",
  };

  return (
    <div>
      <PageHeader
        title="Recetario"
        subtitle={sub}
        info={subDescriptions[subSection]}
        actions={
          <>
            {subSection === "insumos" && (
              <button className="btn btn-acc" onClick={() => triggerAction("nuevo-insumo")}>
                + Nuevo insumo
              </button>
            )}
            {subSection === "materias-primas" && (
              <button
                className="btn btn-acc"
                onClick={() => triggerAction("nueva-mp")}
                disabled={counts.insumos === 0}
                title={counts.insumos === 0 ? "Cargá insumos primero" : ""}
              >
                + Nueva materia prima
              </button>
            )}
            {subSection === "recetas" && (
              <button
                className="btn btn-acc"
                onClick={() => triggerAction("nueva-receta")}
              >
                + Nueva receta / item
              </button>
            )}
          </>
        }
      />

      {/* Layout módulo madre — content + RightSubNav. */}
      <div className="module-with-aside">
        <div style={{ minWidth: 0 }}>
          <Suspense fallback={<div className="loading">Cargando…</div>}>
            {subSection === "insumos" && (
              <Insumos user={user} locales={locales} localActivo={localActivo} embedded />
            )}
            {subSection === "materias-primas" && (
              <MateriasPrimas user={user} locales={locales} localActivo={localActivo} embedded />
            )}
            {subSection === "recetas" && (
              <Recetas user={user} locales={locales} localActivo={localActivo} embedded />
            )}
            {subSection === "cruce" && (
              <Cruce user={user} locales={locales} localActivo={localActivo} embedded />
            )}
            {subSection === "stock" && (
              <Stock user={user} locales={locales} localActivo={localActivo} embedded />
            )}
          </Suspense>
        </div>

        <RightSubNav
          sections={[
            {
              header: "Catálogo",
              activeId: subSection,
              onSelect: (id) => setSubSection(id as SubSection),
              items: [
                {
                  id: "insumos",
                  label: "Insumos",
                  count: counts.insumos,
                  icon: (
                    <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M3 5h8l-.5 7H3.5z" />
                      <path d="M5 5V3.5a2 2 0 0 1 4 0V5" />
                    </svg>
                  ),
                },
                {
                  id: "materias-primas",
                  label: "Materias primas",
                  count: counts.mps,
                  icon: (
                    <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="2" y="3" width="10" height="8" rx="0.5" />
                      <path d="M4 6h6M4 8h6" />
                    </svg>
                  ),
                },
                {
                  id: "recetas",
                  label: "Recetas",
                  count: counts.recetas,
                  icon: (
                    <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M3 2h6l2 2v8H3z" />
                      <path d="M5 5h4M5 7h4M5 9h3" />
                    </svg>
                  ),
                },
                {
                  id: "cruce",
                  label: "Cruce",
                  count: counts.pendientes,
                  icon: (
                    <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M3 3l8 8M11 3l-8 8" />
                    </svg>
                  ),
                },
                {
                  id: "stock",
                  label: "Stock",
                  icon: (
                    <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M2 4l5-2 5 2v6l-5 2-5-2z" />
                      <path d="M2 4l5 2 5-2M7 6v6" />
                    </svg>
                  ),
                },
              ],
            },
            // Banner separado de cobertura — pequeño contexto.
            {
              header: "Cobertura",
              activeId: undefined,
              onSelect: () => { /* no-op, es solo info */ },
              items: [
                {
                  id: "stat-cobertura",
                  label: `${counts.recetas} de ${counts.items} items`,
                  count: counts.items > 0 ? Math.round((counts.recetas / counts.items) * 100) : 0,
                },
              ],
            },
          ] satisfies SubNavSection[]}
        />
      </div>
    </div>
  );
}
