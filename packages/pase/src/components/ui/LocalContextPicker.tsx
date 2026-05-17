import { useEffect, useRef, useState } from "react";

/**
 * LocalContextPicker — dropdown compacto para elegir contexto de local.
 *
 * Reemplaza el switch horizontal de pills que escalaba mal cuando el tenant
 * tiene >3 locales (se llenaba la pantalla). Estilo Linear/Stripe: 1 botón
 * con el valor actual + caret, al click despliega menú con todas las opciones.
 *
 * Opciones del menú:
 *   - "Consolidado" siempre arriba, separado con divider.
 *   - 1 fila por cada local del tenant.
 *
 * Uso:
 * ```tsx
 * <LocalContextPicker
 *   options={[
 *     { id: "consolidado", label: "Consolidado" },
 *     ...locales.map(l => ({ id: String(l.id), label: l.nombre }))
 *   ]}
 *   value={ctx}
 *   onChange={setCtx}
 * />
 * ```
 */

export interface LocalContextOption {
  id: string;
  label: string;
}

interface Props {
  options: LocalContextOption[];
  value: string;
  onChange: (id: string) => void;
}

export function LocalContextPicker({ options, value, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Cerrar al click afuera
  useEffect(() => {
    if (!open) return;
    function handler(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    }
    function escHandler(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", handler);
    document.addEventListener("keydown", escHandler);
    return () => {
      document.removeEventListener("mousedown", handler);
      document.removeEventListener("keydown", escHandler);
    };
  }, [open]);

  const current = options.find(o => o.id === value) ?? options[0];
  if (!current) return null;

  const isConsolidado = current.id === "consolidado";
  const locales = options.filter(o => o.id !== "consolidado");
  const consolidado = options.find(o => o.id === "consolidado");

  return (
    <div ref={ref} className="lcp-root">
      <button
        type="button"
        className={`lcp-trigger ${isConsolidado ? "lcp-trigger--consolidado" : ""}`}
        onClick={() => setOpen(v => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="lcp-icon" aria-hidden>
          {isConsolidado ? (
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <rect x="2" y="2" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.3"/>
              <rect x="9" y="2" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.3"/>
              <rect x="2" y="9" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.3"/>
              <rect x="9" y="9" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.3"/>
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <path d="M3 6L8 2L13 6V13C13 13.5523 12.5523 14 12 14H4C3.44772 14 3 13.5523 3 13V6Z"
                stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/>
              <path d="M6 14V9H10V14" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/>
            </svg>
          )}
        </span>
        <span className="lcp-label">{current.label}</span>
        <span className="lcp-caret" aria-hidden>
          <svg width="10" height="10" viewBox="0 0 12 12" fill="none">
            <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </span>
      </button>

      {open && (
        <div className="lcp-menu" role="listbox">
          {consolidado && (
            <>
              <button
                type="button"
                role="option"
                aria-selected={value === consolidado.id}
                className={`lcp-option ${value === consolidado.id ? "lcp-option--active" : ""}`}
                onClick={() => { onChange(consolidado.id); setOpen(false); }}
              >
                <span className="lcp-option-icon">
                  <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
                    <rect x="2" y="2" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.3"/>
                    <rect x="9" y="2" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.3"/>
                    <rect x="2" y="9" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.3"/>
                    <rect x="9" y="9" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.3"/>
                  </svg>
                </span>
                {consolidado.label}
                <span className="lcp-hint">todos los locales</span>
              </button>
              {locales.length > 0 && <div className="lcp-divider" role="separator" />}
            </>
          )}
          {locales.map(opt => (
            <button
              key={opt.id}
              type="button"
              role="option"
              aria-selected={value === opt.id}
              className={`lcp-option ${value === opt.id ? "lcp-option--active" : ""}`}
              onClick={() => { onChange(opt.id); setOpen(false); }}
            >
              <span className="lcp-option-icon">
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
                  <path d="M3 6L8 2L13 6V13C13 13.5523 12.5523 14 12 14H4C3.44772 14 3 13.5523 3 13V6Z"
                    stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/>
                  <path d="M6 14V9H10V14" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/>
                </svg>
              </span>
              {opt.label}
            </button>
          ))}
        </div>
      )}

      <style>{`
        .lcp-root {
          position: relative;
          display: inline-block;
        }
        .lcp-trigger {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          padding: 7px 10px 7px 12px;
          background: #fff;
          border: 0.5px solid var(--pase-border);
          border-radius: 999px;
          color: var(--pase-text);
          font-family: var(--pase-font);
          font-size: 13px;
          font-weight: 500;
          letter-spacing: -0.01em;
          cursor: pointer;
          transition: border-color 0.15s, box-shadow 0.15s, background 0.15s;
          min-width: 180px;
        }
        .lcp-trigger:hover {
          border-color: var(--pase-celeste-300);
          box-shadow: 0 2px 6px rgba(90, 143, 168, 0.08);
        }
        .lcp-trigger--consolidado {
          background: var(--pase-celeste);
          color: #fff;
          border-color: var(--pase-celeste);
          box-shadow: 0 2px 6px rgba(90, 143, 168, 0.18);
        }
        .lcp-trigger--consolidado:hover {
          background: var(--pase-celeste);
          border-color: var(--pase-celeste);
          box-shadow: 0 4px 10px rgba(90, 143, 168, 0.26);
        }
        .lcp-icon {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          opacity: 0.85;
        }
        .lcp-label {
          flex: 1;
          text-align: left;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .lcp-caret {
          display: inline-flex;
          align-items: center;
          opacity: 0.7;
          transition: transform 0.15s;
        }
        .lcp-trigger[aria-expanded="true"] .lcp-caret {
          transform: rotate(180deg);
        }

        .lcp-menu {
          position: absolute;
          top: calc(100% + 6px);
          right: 0;
          min-width: 240px;
          background: #fff;
          border: 0.5px solid var(--pase-border);
          border-radius: 12px;
          box-shadow: 0 8px 24px rgba(15, 30, 45, 0.10), 0 1px 4px rgba(15, 30, 45, 0.06);
          padding: 6px;
          z-index: 100;
          animation: lcp-fade-in 0.12s ease-out;
        }
        @keyframes lcp-fade-in {
          from { opacity: 0; transform: translateY(-4px); }
          to   { opacity: 1; transform: translateY(0); }
        }

        .lcp-option {
          display: flex;
          align-items: center;
          gap: 9px;
          width: 100%;
          padding: 8px 10px;
          border: none;
          background: transparent;
          border-radius: 8px;
          font-family: var(--pase-font);
          font-size: 13px;
          color: var(--pase-text);
          letter-spacing: -0.005em;
          cursor: pointer;
          text-align: left;
          transition: background 0.1s;
        }
        .lcp-option:hover {
          background: var(--pase-celeste-100, rgba(90, 143, 168, 0.08));
        }
        .lcp-option--active {
          background: var(--pase-celeste);
          color: #fff;
          font-weight: 500;
        }
        .lcp-option--active:hover {
          background: var(--pase-celeste);
        }
        .lcp-option-icon {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          opacity: 0.7;
          flex-shrink: 0;
        }
        .lcp-option--active .lcp-option-icon {
          opacity: 1;
        }
        .lcp-hint {
          margin-left: auto;
          font-size: 10.5px;
          color: var(--pase-text-muted);
          font-weight: 400;
          letter-spacing: 0.01em;
        }
        .lcp-option--active .lcp-hint {
          color: rgba(255, 255, 255, 0.75);
        }
        .lcp-divider {
          height: 0.5px;
          background: var(--pase-border);
          margin: 4px 6px;
        }
      `}</style>
    </div>
  );
}
