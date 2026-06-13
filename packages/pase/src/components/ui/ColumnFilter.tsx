import { useState, useRef, useEffect } from "react";

interface ColumnFilterProps {
  label: string;
  values: string[];
  selected: Set<string>;
  onChange: (selected: Set<string>) => void;
  align?: "left" | "right";
}

export function ColumnFilter({ label, values, selected, onChange, align = "left" }: ColumnFilterProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const isFiltered = selected.size > 0 && selected.size < values.length;

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const sorted = [...values].sort((a, b) => a.localeCompare(b, "es"));
  const filtered = search ? sorted.filter(v => v.toLowerCase().includes(search.toLowerCase())) : sorted;

  const toggle = (v: string) => {
    const next = new Set(selected);
    if (next.has(v)) next.delete(v); else next.add(v);
    if (next.size === values.length) { onChange(new Set()); return; }
    onChange(next);
  };

  const selectAll = () => onChange(new Set());
  const selectNone = () => onChange(new Set(["__none__"]));

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
        title="Filtrar columna"
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
            minWidth: 180,
            maxWidth: 260,
            maxHeight: 320,
            display: "flex",
            flexDirection: "column",
            fontFamily: "var(--pase-font)",
          }}
        >
          {values.length > 8 && (
            <div style={{ padding: "8px 10px 4px" }}>
              <input
                type="text"
                placeholder="Buscar..."
                value={search}
                onChange={e => setSearch(e.target.value)}
                autoFocus
                style={{
                  width: "100%", height: 28, fontSize: 11,
                  background: "var(--pase-bg-soft)", border: "0.5px solid var(--pase-border)",
                  borderRadius: 6, padding: "0 8px", color: "var(--pase-text)",
                  fontFamily: "var(--pase-font)",
                  outline: "none",
                }}
              />
            </div>
          )}

          <div style={{ padding: "6px 10px 2px", display: "flex", gap: 8, fontSize: 10, color: "var(--pase-text-muted)" }}>
            <button type="button" onClick={selectAll} style={{ background: "none", border: "none", color: "var(--pase-celeste)", cursor: "pointer", fontSize: 10, padding: 0, fontFamily: "var(--pase-font)" }}>
              Todos
            </button>
            <button type="button" onClick={selectNone} style={{ background: "none", border: "none", color: "var(--pase-text-muted)", cursor: "pointer", fontSize: 10, padding: 0, fontFamily: "var(--pase-font)" }}>
              Ninguno
            </button>
          </div>

          <div style={{ overflowY: "auto", padding: "4px 6px 8px", flex: 1 }}>
            {filtered.map(v => {
              const checked = selected.size === 0 || selected.has(v);
              return (
                <label
                  key={v}
                  style={{
                    display: "flex", alignItems: "center", gap: 6,
                    padding: "3px 4px", borderRadius: 4, cursor: "pointer",
                    fontSize: 11, color: "var(--pase-text)",
                    whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                  }}
                  onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = "var(--pase-bg-soft)"; }}
                  onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = ""; }}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggle(v)}
                    style={{ accentColor: "var(--pase-celeste)", margin: 0, flexShrink: 0 }}
                  />
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{v || "—"}</span>
                </label>
              );
            })}
            {filtered.length === 0 && (
              <div style={{ padding: 8, fontSize: 11, color: "var(--pase-text-muted)", textAlign: "center" }}>
                Sin resultados
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any, react-refresh/only-export-components
export function useColumnFilters<T = any>(
  data: T[],
  columns: Record<string, (row: T) => string>,
) {
  const [filters, setFilters] = useState<Record<string, Set<string>>>({});

  const uniqueValues = (col: string): string[] => {
    const fn = columns[col];
    if (!fn) return [];
    const set = new Set<string>();
    for (const row of data) {
      const v = fn(row);
      if (v !== undefined && v !== null) set.add(v);
    }
    return [...set];
  };

  const setFilter = (col: string, selected: Set<string>) => {
    setFilters(prev => {
      const next = { ...prev };
      if (selected.size === 0 || (selected.size === 1 && selected.has("__none__") && uniqueValues(col).length === 0)) {
        delete next[col];
      } else {
        next[col] = selected;
      }
      return next;
    });
  };

  const filtered = data.filter(row => {
    for (const [col, sel] of Object.entries(filters)) {
      if (sel.size === 0) continue;
      if (sel.size === 1 && sel.has("__none__")) return false;
      const fn = columns[col];
      if (!fn) continue;
      const v = fn(row);
      if (!sel.has(v)) return false;
    }
    return true;
  });

  const getFilter = (col: string) => filters[col] ?? new Set<string>();

  return { filtered, uniqueValues, getFilter, setFilter, hasActiveFilters: Object.keys(filters).length > 0, clearAll: () => setFilters({}) };
}
