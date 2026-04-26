import { useState } from "react";
import Insumos from "./Insumos";
import Recetas from "./Recetas";
import ListaPrecios from "./ListaPrecios";

export default function Costos({ user, locales, localActivo }) {
  const [tab, setTab] = useState("insumos");
  const tabs: [string, string][] = [
    ["insumos", "Insumos"],
    ["recetas", "Recetas"],
    ["precios", "Lista de Precios"],
  ];

  return (
    <div>
      <div className="ph-row">
        <div><div className="ph-title">Costos</div></div>
      </div>
      <div className="tabs">
        {tabs.map(([id, l]) => (
          <div key={id} className={`tab ${tab === id ? "active" : ""}`} onClick={() => setTab(id)}>{l}</div>
        ))}
      </div>
      {tab === "insumos" && <Insumos />}
      {tab === "recetas" && <Recetas locales={locales} localActivo={localActivo} />}
      {tab === "precios" && <ListaPrecios locales={locales} localActivo={localActivo} />}
    </div>
  );
}
