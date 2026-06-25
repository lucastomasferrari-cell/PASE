// MensajeriaIG — se MUDÓ a Habitué (25-jun-2026).
//
// La UI del bot de Instagram vive ahora en Habitué (sección "Mensajería IG").
// El backend del bot sigue en pase-instagram-bot.vercel.app (Meta apunta su
// webhook ahí — no se movió). Esta pantalla queda como redirect para no
// romper links históricos del sidebar.
//
// La versión completa de esta pantalla (1868 líneas con IGConfigModal,
// IGClienteModal, IGConexionPanel, NotificacionesPushToggle) está en el
// historial de git si hay que recuperarla.

import type { Usuario } from "../types";

const HABITUE_URL =
  (import.meta.env.VITE_HABITUE_URL as string | undefined) || "https://habitue.vercel.app";

function MessageCircleIcon({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>
    </svg>
  );
}
function ExternalLinkIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
      <polyline points="15 3 21 3 21 9"/>
      <line x1="10" y1="14" x2="21" y2="3"/>
    </svg>
  );
}

interface Props { user: Usuario }

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export default function MensajeriaIG(_props: Props) {
  return (
    <div style={{ display: "grid", placeItems: "center", minHeight: "60vh", padding: 24 }}>
      <div style={{
        maxWidth: 460, background: "var(--s1)", border: "1px solid var(--bd)",
        borderRadius: 16, padding: 32, textAlign: "center",
      }}>
        <div style={{
          width: 56, height: 56, borderRadius: 14, background: "var(--s2)",
          color: "var(--acc)", display: "grid", placeItems: "center",
          margin: "0 auto 16px",
        }}>
          <MessageCircleIcon size={28} />
        </div>
        <h2 style={{ fontSize: 20, margin: "0 0 8px" }}>La mensajería se mudó a Habitué</h2>
        <p style={{ color: "var(--muted2)", fontSize: 14, margin: "0 0 20px", lineHeight: 1.5 }}>
          Junto con marketing/CRM. El bot sigue funcionando igual; lo operás desde Habitué.
        </p>
        <a href={`${HABITUE_URL}/?seccion=mensajeria`} target="_blank" rel="noopener noreferrer"
           style={{
             display: "inline-flex", alignItems: "center", gap: 8,
             background: "var(--acc)", color: "white", padding: "10px 18px",
             borderRadius: 10, textDecoration: "none", fontSize: 14, fontWeight: 500,
           }}>
          Abrir Habitué <ExternalLinkIcon size={14} />
        </a>
        <p style={{ color: "var(--muted2)", fontSize: 11, marginTop: 16 }}>
          ¿No tenés acceso a Habitué? Pedile a quien gestione el equipo que te lo dé.
        </p>
      </div>
    </div>
  );
}
