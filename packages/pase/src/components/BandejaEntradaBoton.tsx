import { useState, useRef, useEffect, type ReactElement } from "react";
import { useNavigate } from "react-router-dom";
import { useBandejaEntrada, type Notif, type NotifSource } from "../lib/useBandejaEntrada";
import { fmt_dt_ar } from "../lib/utils";
import { PinIcon, KeyIcon, AlertIcon, CalendarIcon, BellIcon, WalletIcon } from "./ui";
import type { Usuario } from "../types";

/**
 * BandejaEntradaBoton — campana de notificaciones en el sidebar.
 *
 * Botón con badge dorado de no-leídas. Click → popover lateral con la lista.
 * Cada item: ícono + título + descripción + fecha relativa.
 *
 * Click en un item → navega a su href y marca leído.
 * Botón "Marcar todas" en el footer.
 *
 * Si el user no tiene novedades, la campana se ve apagada (sin badge).
 *
 * Diseño 2026-05-18 — MVP consolidación.
 */

interface Props {
  user: Usuario;
}

// Cada fuente tiene su icono SVG line-art (coherente con el design system).
// Tono: factura_vencida usa gold para llamar atención sin gritar; el resto
// queda en muted neutro para no competir entre sí.
const SOURCE_ICON_RENDER: Record<NotifSource, () => ReactElement> = {
  tarea:                () => <PinIcon size={14} tone="muted" />,
  override:             () => <KeyIcon size={14} tone="muted" />,
  factura_vencida:      () => <AlertIcon size={14} tone="gold" />,
  factura_por_vencer:   () => <CalendarIcon size={14} tone="muted" />,
  mp_sin_conciliar:     () => <WalletIcon size={14} tone="muted" />,
  // Solicitudes de autorización pendientes — usa el ícono key (mismo
  // significado que override) con tono gold para llamar atención.
  solicitud_pendiente:  () => <KeyIcon size={14} tone="gold" />,
};

const SOURCE_LABELS: Record<NotifSource, string> = {
  tarea: "Tarea",
  override: "Código usado",
  factura_vencida: "Vencidas",
  factura_por_vencer: "Por vencer",
  mp_sin_conciliar: "MP sin conciliar",
  solicitud_pendiente: "Solicitud pendiente",
};

function fmtRelativo(iso: string): string {
  const d = new Date(iso).getTime();
  const now = Date.now();
  const secs = Math.floor((now - d) / 1000);
  if (secs < 60) return "Recién";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const dias = Math.floor(hrs / 24);
  if (dias < 7) return `${dias}d`;
  return fmt_dt_ar(iso).slice(0, 5); // DD/MM
}

export function BandejaEntradaBoton({ user }: Props) {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const popoverRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const { notifs, loading, countNoLeidas, marcarLeida, marcarTodasLeidas } = useBandejaEntrada(user);

  // Cerrar al click fuera o ESC
  useEffect(() => {
    if (!open) return;
    function handleClickOutside(e: MouseEvent) {
      const t = e.target as Node;
      if (popoverRef.current?.contains(t)) return;
      if (buttonRef.current?.contains(t)) return;
      setOpen(false);
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  function handleClickItem(n: Notif) {
    marcarLeida(n.id);
    if (n.href) {
      setOpen(false);
      navigate(n.href);
    }
  }

  return (
    <div style={{ position: "relative" }}>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-label={countNoLeidas > 0 ? `${countNoLeidas} notificaciones sin leer` : "Bandeja de entrada"}
        title="Bandeja de entrada"
        style={{
          position: "relative",
          background: "transparent",
          border: "none",
          padding: 6,
          cursor: "pointer",
          color: countNoLeidas > 0 ? "var(--pase-text)" : "var(--pase-text-muted)",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        {countNoLeidas > 0 && (
          <span style={{
            position: "absolute",
            top: 2,
            right: 2,
            minWidth: 16,
            height: 16,
            padding: "0 4px",
            background: "var(--pase-gold)",
            color: "#1A3A5E",
            borderRadius: 999,
            fontSize: 10,
            fontWeight: 600,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            lineHeight: 1,
            fontVariantNumeric: "tabular-nums",
          }}>
            {countNoLeidas > 99 ? "99+" : countNoLeidas}
          </span>
        )}
      </button>

      {open && (
        <div
          ref={popoverRef}
          style={{
            position: "absolute",
            top: "calc(100% + 8px)",
            right: 0,
            width: 380,
            maxHeight: 540,
            background: "var(--pase-bg)",
            border: "0.5px solid var(--pase-border)",
            borderRadius: 12,
            boxShadow: "0 8px 24px rgba(0, 0, 0, 0.12), 0 2px 4px rgba(0, 0, 0, 0.04)",
            zIndex: 200,
            display: "flex",
            flexDirection: "column",
          }}
        >
          {/* Header */}
          <div style={{
            padding: "12px 16px",
            borderBottom: "0.5px solid var(--pase-border)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}>
            <div style={{
              fontSize: "var(--pase-fs-md)",
              fontWeight: 500,
              color: "var(--pase-text)",
            }}>
              Bandeja
              {countNoLeidas > 0 && (
                <span style={{
                  marginLeft: 8,
                  fontSize: "var(--pase-fs-xs)",
                  color: "var(--pase-text-muted)",
                  fontWeight: 400,
                }}>
                  {countNoLeidas} sin leer
                </span>
              )}
            </div>
            {countNoLeidas > 0 && (
              <button
                type="button"
                onClick={marcarTodasLeidas}
                style={{
                  background: "transparent",
                  border: "none",
                  color: "var(--pase-celeste)",
                  fontSize: "var(--pase-fs-xs)",
                  cursor: "pointer",
                  fontFamily: "inherit",
                  padding: 0,
                }}
              >
                Marcar todas
              </button>
            )}
          </div>

          {/* Lista */}
          <div style={{ flex: 1, overflowY: "auto", padding: 4 }}>
            {loading && (
              <div style={{ padding: 24, textAlign: "center", color: "var(--pase-text-muted)", fontSize: "var(--pase-fs-sm)" }}>
                Cargando…
              </div>
            )}
            {!loading && notifs.length === 0 && (
              <div style={{ padding: 32, textAlign: "center", color: "var(--pase-text-muted)" }}>
                <div style={{ marginBottom: 10, display: "flex", justifyContent: "center" }}>
                  <BellIcon size={28} tone="muted" />
                </div>
                <div style={{ fontSize: "var(--pase-fs-sm)" }}>Sin novedades.</div>
                <div style={{ fontSize: "var(--pase-fs-xs)", marginTop: 4 }}>
                  Acá te van a llegar las tareas, alertas y otros avisos.
                </div>
              </div>
            )}
            {!loading && notifs.map(n => (
              <button
                key={n.id}
                type="button"
                onClick={() => handleClickItem(n)}
                style={{
                  display: "block",
                  width: "100%",
                  textAlign: "left",
                  padding: "10px 12px",
                  margin: 2,
                  borderRadius: 8,
                  background: n.leido ? "transparent" : "var(--pase-celeste-100)",
                  border: "0.5px solid transparent",
                  cursor: "pointer",
                  fontFamily: "inherit",
                  transition: "background 0.15s",
                }}
                onMouseEnter={e => { e.currentTarget.style.background = n.leido ? "var(--pase-bg-soft)" : "var(--pase-celeste-200)"; }}
                onMouseLeave={e => { e.currentTarget.style.background = n.leido ? "transparent" : "var(--pase-celeste-100)"; }}
              >
                <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8, marginBottom: 4 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, flex: 1, minWidth: 0 }}>
                    <span aria-hidden style={{ display: "inline-flex", alignItems: "center" }}>
                      {SOURCE_ICON_RENDER[n.source]()}
                    </span>
                    <span style={{
                      fontSize: "var(--pase-fs-xs)",
                      color: "var(--pase-text-muted)",
                      textTransform: "uppercase",
                      letterSpacing: "var(--pase-ls-overline)",
                      fontWeight: 500,
                    }}>
                      {SOURCE_LABELS[n.source]}
                    </span>
                  </div>
                  <span style={{ fontSize: "var(--pase-fs-xs)", color: "var(--pase-text-muted)", flexShrink: 0 }}>
                    {fmtRelativo(n.fecha)}
                  </span>
                </div>
                <div style={{
                  fontSize: "var(--pase-fs-sm)",
                  fontWeight: n.leido ? 400 : 500,
                  color: "var(--pase-text)",
                  marginBottom: 2,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  display: "-webkit-box",
                  WebkitLineClamp: 2,
                  WebkitBoxOrient: "vertical",
                }}>
                  {n.titulo}
                </div>
                {n.descripcion && (
                  <div style={{
                    fontSize: "var(--pase-fs-xs)",
                    color: "var(--pase-text-muted)",
                    lineHeight: 1.4,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    display: "-webkit-box",
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: "vertical",
                  }}>
                    {n.descripcion}
                  </div>
                )}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
