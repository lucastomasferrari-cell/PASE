import type { Local } from "../../types";

/**
 * Componentes UI estándar para el modelo de selección de sucursales
 * definido por Lucas 2026-05-17 (ver `useLocalContextoUI`).
 *
 *   - <LocalLockedChip>: chip celeste 🔒 con el nombre de la sucursal
 *     cuando viene bloqueada por el sidebar.
 *
 *   - <LocalSelectorObligatorio>: dropdown que aparece cuando el sidebar
 *     dice "Todas" y el contexto es de carga. Bloquea submit hasta elegir.
 *
 *   - <LocalSelectorOpcional>: igual pero permite "Todas" como opción
 *     válida (modo vista). Usar cuando una pantalla acepta consolidado.
 */

interface ChipProps {
  /** Nombre del local activo bloqueado por el sidebar. */
  nombre: string;
  /** Texto explicativo opcional, default: "desde el sidebar" */
  hint?: string;
}

export function LocalLockedChip({ nombre, hint = "desde el sidebar" }: ChipProps) {
  return (
    <div
      title={`Sucursal bloqueada ${hint}. Para cambiar, andá al selector del sidebar.`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "0 12px",
        height: "var(--pase-h-sm)",
        background: "var(--pase-celeste-100)",
        borderRadius: 8,
        fontSize: "var(--pase-fs-sm)",
        color: "var(--pase-text)",
        border: "0.5px solid var(--pase-celeste-300)",
        fontWeight: 500,
        whiteSpace: "nowrap",
      }}
    >
      <span style={{ fontSize: 10, opacity: 0.7 }}>🔒</span>
      {nombre}
    </div>
  );
}

interface SelectorProps {
  /** Valor activo (id del local), null si no se eligió. */
  value: number | null;
  onChange: (id: number | null) => void;
  locales: Local[];
  /** Texto al primer item — solo aplicable al opcional. */
  placeholderTodas?: string;
  /** width fijo (default 200) */
  width?: number;
  /** id para asociar con un <label> */
  id?: string;
}

/**
 * Dropdown OBLIGATORIO: no permite "Todas". Si value=null muestra placeholder
 * "Elegí una sucursal —". Usar en modales de carga / pantallas que necesitan
 * una sucursal específica.
 */
export function LocalSelectorObligatorio({ value, onChange, locales, width = 200, id }: SelectorProps) {
  return (
    <select
      id={id}
      value={value ?? ""}
      onChange={e => onChange(e.target.value ? Number(e.target.value) : null)}
      className="search"
      style={{ width, borderColor: value === null ? "#D97706" : undefined }}
    >
      <option value="">— Seleccionar sucursal —</option>
      {locales.map(l => (
        <option key={l.id} value={l.id}>{l.nombre}</option>
      ))}
    </select>
  );
}

/**
 * Dropdown OPCIONAL: permite "Todas" como valor válido. Usar en pantallas
 * de vista que aceptan consolidado.
 */
export function LocalSelectorOpcional({ value, onChange, locales, placeholderTodas = "Todas las sucursales", width = 200, id }: SelectorProps) {
  return (
    <select
      id={id}
      value={value ?? ""}
      onChange={e => onChange(e.target.value ? Number(e.target.value) : null)}
      className="search"
      style={{ width }}
    >
      <option value="">{placeholderTodas}</option>
      {locales.map(l => (
        <option key={l.id} value={l.id}>{l.nombre}</option>
      ))}
    </select>
  );
}

/**
 * Componente combinado: muestra automáticamente Chip si está bloqueado,
 * o Selector si no. Cubre el 90% de los usos. Si necesitás más control,
 * usar los 3 componentes por separado.
 */
interface ComboProps {
  bloqueado: boolean;
  nombreSucursal: string;
  value: number | null;
  onChange: (id: number | null) => void;
  locales: Local[];
  /** "carga" usa Selector Obligatorio. "vista" usa Selector Opcional. */
  modo: "carga" | "vista";
  width?: number;
}

export function LocalContextoChip({ bloqueado, nombreSucursal, value, onChange, locales, modo, width }: ComboProps) {
  if (bloqueado) {
    return <LocalLockedChip nombre={nombreSucursal} />;
  }
  if (modo === "carga") {
    return <LocalSelectorObligatorio value={value} onChange={onChange} locales={locales} width={width} />;
  }
  return <LocalSelectorOpcional value={value} onChange={onChange} locales={locales} width={width} />;
}
