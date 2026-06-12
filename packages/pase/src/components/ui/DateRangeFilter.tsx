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

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

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
              value={desde}
              onChange={e => onDesdeChange(e.target.value)}
              style={{
                flex: 1, height: 28, fontSize: 11,
                background: "var(--pase-bg-soft)", border: "0.5px solid var(--pase-border)",
                borderRadius: 6, padding: "0 6px", color: "var(--pase-text)",
                fontFamily: "var(--pase-font)", outline: "none",
              }}
            />
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <label style={{ fontSize: 10, color: "var(--pase-text-muted)", fontWeight: 500, minWidth: 38 }}>Hasta</label>
            <input
              type="date"
              value={hasta}
              onChange={e => onHastaChange(e.target.value)}
              style={{
                flex: 1, height: 28, fontSize: 11,
                background: "var(--pase-bg-soft)", border: "0.5px solid var(--pase-border)",
                borderRadius: 6, padding: "0 6px", color: "var(--pase-text)",
                fontFamily: "var(--pase-font)", outline: "none",
              }}
            />
          </div>
          {isFiltered && (
            <button
              type="button"
              onClick={() => { onDesdeChange(""); onHastaChange(""); }}
              style={{
                background: "none", border: "none", color: "var(--pase-celeste)",
                cursor: "pointer", fontSize: 10, padding: 0, fontFamily: "var(--pase-font)",
                textAlign: "left",
              }}
            >
              Limpiar filtro
            </button>
          )}
        </div>
      )}
    </div>
  );
}
