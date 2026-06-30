import { useState, useRef, useEffect } from "react";

interface DateRangeFilterProps {
  label: string;
  desde: string;
  hasta: string;
  onDesdeChange: (v: string) => void;
  onHastaChange: (v: string) => void;
  align?: "left" | "right";
}

export function DateRangeFilter({ label, desde, hasta, onDesdeChange, onHastaChange, align = "left" }: DateRangeFilterProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const isFiltered = !!desde || !!hasta;

  // Draft local: escribir/elegir fecha NO re-filtra la tabla en cada cambio.
  // Recién se aplica al tocar "Aplicar" o al cerrar el dropdown. Evita el
  // re-fetch/re-render por cada fecha intermedia válida (sensación de trabado).
  const [draftDesde, setDraftDesde] = useState(desde);
  const [draftHasta, setDraftHasta] = useState(hasta);

  // Al abrir, sincronizar el draft con lo aplicado.
  useEffect(() => {
    if (open) { setDraftDesde(desde); setDraftHasta(hasta); }
  }, [open, desde, hasta]);

  const commit = () => {
    if (draftDesde !== desde) onDesdeChange(draftDesde);
    if (draftHasta !== hasta) onHastaChange(draftHasta);
  };

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        commit();        // aplicar al cerrar por click afuera
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, draftDesde, draftHasta, desde, hasta]);

  const inputStyle: React.CSSProperties = {
    flex: 1, height: 28, fontSize: 11,
    background: "var(--pase-bg-soft)", border: "0.5px solid var(--pase-border)",
    borderRadius: 6, padding: "0 6px", color: "var(--pase-text)",
    fontFamily: "var(--pase-font)", outline: "none",
  };

  return (
    <div ref={ref} style={{ position: "relative", display: "inline-flex", alignItems: "center", gap: 4 }}>
      <span>{label}</span>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        style={{
          background: "none", border: "none", cursor: "pointer", padding: 2,
          color: isFiltered ? "var(--pase-celeste)" : "var(--pase-text-muted)",
          opacity: isFiltered ? 1 : 0.5,
          display: "inline-flex", alignItems: "center",
        }}
        title="Filtrar por fecha"
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M1.5 2h13l-5 6v5l-3 1.5V8z" />
        </svg>
      </button>

      {open && (
        <div
          style={{
            position: "absolute",
            top: "100%",
            [align === "right" ? "right" : "left"]: 0,
            marginTop: 4,
            zIndex: 200,
            background: "var(--pase-bg)",
            border: "0.5px solid var(--pase-border-strong)",
            borderRadius: 10,
            boxShadow: "var(--pase-shadow-lg)",
            minWidth: 200,
            padding: "12px 14px",
            display: "flex",
            flexDirection: "column",
            gap: 8,
            fontFamily: "var(--pase-font)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <label style={{ fontSize: 10, color: "var(--pase-text-muted)", fontWeight: 500, minWidth: 38 }}>Desde</label>
            <input
              type="date"
              value={draftDesde}
              onChange={e => setDraftDesde(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") { commit(); setOpen(false); } }}
              style={inputStyle}
            />
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <label style={{ fontSize: 10, color: "var(--pase-text-muted)", fontWeight: 500, minWidth: 38 }}>Hasta</label>
            <input
              type="date"
              value={draftHasta}
              onChange={e => setDraftHasta(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") { commit(); setOpen(false); } }}
              style={inputStyle}
            />
          </div>

          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginTop: 2 }}>
            {(draftDesde || draftHasta) ? (
              <button
                type="button"
                onClick={() => { setDraftDesde(""); setDraftHasta(""); onDesdeChange(""); onHastaChange(""); setOpen(false); }}
                style={{
                  background: "none", border: "none", color: "var(--pase-text-muted)",
                  cursor: "pointer", fontSize: 10, padding: 0, fontFamily: "var(--pase-font)",
                }}
              >
                Limpiar
              </button>
            ) : <span />}
            <button
              type="button"
              onClick={() => { commit(); setOpen(false); }}
              style={{
                background: "var(--pase-celeste)", border: "none", color: "#fff",
                cursor: "pointer", fontSize: 11, fontWeight: 500, padding: "5px 14px",
                borderRadius: 6, fontFamily: "var(--pase-font)",
              }}
            >
              Aplicar
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
