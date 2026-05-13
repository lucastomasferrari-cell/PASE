import { useEffect, useMemo, useRef, useState } from "react";

// Combobox / searchable select reusable. Reemplaza <select> cuando la
// lista de opciones es larga (proveedores, categorías, tipos editables,
// etc). Comportamiento:
//   - Input principal donde el usuario escribe → filtra opciones case-
//     insensitive sobre el label.
//   - Click en el input abre la lista entera (igual que un dropdown).
//   - Click en una opción / Enter / Tab → selecciona y cierra.
//   - Escape / blur fuera del componente → cierra sin cambiar.
//   - Soporta opcionalmente "groups" para agrupar visualmente
//     (ej. categorías por tipo).
//
// Sin dependencias externas. Estilo via clases existentes ('field', 'search')
// + inline overrides — coherente con el resto de la app.

export interface ComboboxOption {
  value: string;
  label: string;
  group?: string;
}

interface ComboboxProps {
  value: string;
  onChange: (value: string) => void;
  options: ComboboxOption[];
  placeholder?: string;
  // Si está set, deshabilita la apertura del dropdown (modo readonly).
  disabled?: boolean;
  // Si está set, agrupa las opciones bajo headers con este orden.
  groupOrder?: string[];
  // Permite limpiar la selección con un botón ✕ a la derecha.
  clearable?: boolean;
  // Estilo CSS del input. Por default usa 100% width.
  style?: React.CSSProperties;
  // Texto que se muestra cuando no hay match en el filtro.
  emptyMessage?: string;
}

export function Combobox({
  value,
  onChange,
  options,
  placeholder = "Buscar...",
  disabled = false,
  groupOrder,
  clearable = false,
  style,
  emptyMessage = "Sin resultados",
}: ComboboxProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // El label visible en el input cuando NO está abierto: el de la opción
  // seleccionada (busca en options por value). Cuando está abierto se
  // muestra lo que el usuario está tipeando.
  const selectedLabel = useMemo(() => {
    if (!value) return "";
    return options.find(o => o.value === value)?.label || "";
  }, [value, options]);

  // Filtrar opciones por query. Si query está vacío muestra todas.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter(o => o.label.toLowerCase().includes(q));
  }, [query, options]);

  // Agrupar si corresponde. Devuelve un array de tuplas [group, items].
  const grouped = useMemo<[string | null, ComboboxOption[]][]>(() => {
    if (!groupOrder || groupOrder.length === 0) {
      return [[null, filtered]];
    }
    const map = new Map<string, ComboboxOption[]>();
    const sinGrupo: ComboboxOption[] = [];
    for (const o of filtered) {
      if (o.group) {
        const arr = map.get(o.group) || [];
        arr.push(o);
        map.set(o.group, arr);
      } else {
        sinGrupo.push(o);
      }
    }
    const out: [string | null, ComboboxOption[]][] = [];
    for (const g of groupOrder) {
      const items = map.get(g);
      if (items && items.length > 0) out.push([g, items]);
    }
    if (sinGrupo.length > 0) out.push([null, sinGrupo]);
    return out;
  }, [filtered, groupOrder]);

  // Lista plana de opciones (en orden de render) para que las flechas
  // del teclado naveguen correctamente entre grupos.
  const flatOptions = useMemo(() => grouped.flatMap(([, items]) => items), [grouped]);

  // Cerrar al click afuera.
  useEffect(() => {
    if (!open) return;
    const onClickOutside = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
        setQuery("");
      }
    };
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [open]);

  const handleSelect = (opt: ComboboxOption) => {
    onChange(opt.value);
    setOpen(false);
    setQuery("");
    setHighlight(0);
  };

  const handleClear = (e: React.MouseEvent) => {
    e.stopPropagation();
    onChange("");
    setQuery("");
    setHighlight(0);
    inputRef.current?.focus();
  };

  const handleKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (disabled) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!open) setOpen(true);
      setHighlight(h => Math.min(h + 1, flatOptions.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight(h => Math.max(h - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const opt = flatOptions[highlight];
      if (opt) handleSelect(opt);
    } else if (e.key === "Escape") {
      setOpen(false);
      setQuery("");
    }
  };

  return (
    <div ref={wrapRef} style={{ position: "relative", ...style }}>
      <div style={{ position: "relative" }}>
        <input
          ref={inputRef}
          className="search"
          style={{ width: "100%", paddingRight: clearable && value ? 28 : 8 }}
          placeholder={placeholder}
          value={open ? query : selectedLabel}
          disabled={disabled}
          onChange={e => { setQuery(e.target.value); setOpen(true); setHighlight(0); }}
          onFocus={() => { if (!disabled) setOpen(true); }}
          onKeyDown={handleKey}
        />
        {clearable && value && !disabled && (
          <button
            type="button"
            onClick={handleClear}
            style={{
              position: "absolute",
              right: 4,
              top: "50%",
              transform: "translateY(-50%)",
              background: "transparent",
              border: "none",
              color: "var(--muted2)",
              cursor: "pointer",
              fontSize: 14,
              padding: "0 6px",
            }}
            aria-label="Limpiar"
          >
            ✕
          </button>
        )}
      </div>
      {open && (
        <div
          style={{
            position: "absolute",
            top: "100%",
            left: 0,
            right: 0,
            marginTop: 2,
            background: "var(--bg2)",
            border: "1px solid var(--bd2)",
            borderRadius: "var(--r)",
            boxShadow: "0 4px 16px rgba(0,0,0,0.4)",
            maxHeight: 280,
            overflowY: "auto",
            zIndex: 100,
          }}
        >
          {flatOptions.length === 0 ? (
            <div style={{ padding: "10px 12px", fontSize: 11, color: "var(--muted)" }}>{emptyMessage}</div>
          ) : (
            grouped.map(([group, items]) => (
              <div key={group || "_"}>
                {group && (
                  <div style={{
                    padding: "6px 10px 4px",
                    fontSize: 9,
                    letterSpacing: 1,
                    textTransform: "uppercase",
                    color: "var(--muted)",
                    background: "var(--s2)",
                    fontWeight:500,
                  }}>{group}</div>
                )}
                {items.map(opt => {
                  const idx = flatOptions.indexOf(opt);
                  const isHighlighted = idx === highlight;
                  const isSelected = opt.value === value;
                  return (
                    <div
                      key={opt.value}
                      onMouseDown={e => { e.preventDefault(); handleSelect(opt); }}
                      onMouseEnter={() => setHighlight(idx)}
                      style={{
                        padding: "8px 10px",
                        fontSize: 12,
                        cursor: "pointer",
                        background: isHighlighted ? "var(--s2)" : "transparent",
                        color: isSelected ? "var(--acc)" : "var(--txt)",
                        fontWeight: isSelected ? 500 : 400,
                      }}
                    >
                      {opt.label}
                    </div>
                  );
                })}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
