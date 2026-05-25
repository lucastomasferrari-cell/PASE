// ─────────────────────────────────────────────────────────────────────
// Rentabilidad — módulo "Stock & CMV" en PASE.
//
// Visión PASE original (Lucas, doc PASE.txt): "el Módulo de Stock es, junto
// con Tesorería, el lugar donde se protege la rentabilidad".
//
// 4 tabs:
//   - Stock:     dashboard valorizado multi-local + alertas de quiebre
//   - CMV:       Teórico vs Real + Eficiencia % + items con margen negativo
//   - Simulador: what-if con elasticidad configurable (por % o por item)
//   - Alertas:   brecha de eficiencia + posible fuga + margen erosionado
//
// Las acciones operativas (cargar conteo, mermas, ajustes) viven en COMANDA.
// Esta pantalla es solo análisis para el dueño: "ver la info masticada".
// ─────────────────────────────────────────────────────────────────────

import { useState } from "react";
import type { Usuario, Local } from "../types";
import { InfoTooltip } from "../components/ui";
import { TabStock } from "./rentabilidad/TabStock";
import { TabCMV } from "./rentabilidad/TabCMV";
import { TabSimulador } from "./rentabilidad/TabSimulador";
import { TabAlertas } from "./rentabilidad/TabAlertas";
import { TabComprasSugeridas } from "./rentabilidad/TabComprasSugeridas";

interface RentabilidadProps {
  user: Usuario;
  locales: Local[];
  localActivo: number | null;
}

type TabId = "stock" | "cmv" | "simulador" | "alertas" | "compras";

const TABS: Array<{ id: TabId; label: string; desc: string }> = [
  { id: "stock",     label: "Stock",     desc: "Valor del inventario por local y categoría" },
  { id: "cmv",       label: "CMV",       desc: "Teórico vs Real + Eficiencia" },
  { id: "compras",   label: "Compras",   desc: "Forecast de compras sugeridas por par-level" },
  { id: "simulador", label: "Simulador", desc: "What-if: subo precios, baja costo, etc." },
  { id: "alertas",   label: "Alertas",   desc: "Brecha, fuga, margen erosionado" },
];

export default function Rentabilidad({ user, locales, localActivo }: RentabilidadProps) {
  const [tab, setTab] = useState<TabId>("stock");

  return (
    <div>
      <div className="ph-row">
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <div className="ph-title">Rentabilidad</div>
          <InfoTooltip maxWidth={340}>
            El lugar donde se protege la rentabilidad: stock valorizado, CMV
            teórico vs real, simulador de sensibilidad y alertas de fuga.
            Las acciones de stock (conteo, mermas, ajustes) se cargan desde
            COMANDA.
          </InfoTooltip>
        </div>
      </div>

      <div className="tabs" style={{ marginBottom: 16 }}>
        {TABS.map(t => (
          <div
            key={t.id}
            className={`tab ${tab === t.id ? "active" : ""}`}
            onClick={() => setTab(t.id)}
            title={t.desc}
          >
            {t.label}
          </div>
        ))}
      </div>

      {tab === "stock"     && <TabStock            user={user} locales={locales} localActivo={localActivo} />}
      {tab === "cmv"       && <TabCMV              user={user} locales={locales} localActivo={localActivo} />}
      {tab === "compras"   && <TabComprasSugeridas user={user} locales={locales} localActivo={localActivo} />}
      {tab === "simulador" && <TabSimulador        user={user} locales={locales} localActivo={localActivo} />}
      {tab === "alertas"   && <TabAlertas          user={user} locales={locales} localActivo={localActivo} />}
    </div>
  );
}
