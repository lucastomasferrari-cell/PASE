import { PageContainer } from "../components/ui";

function IconExternal() {
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 2H2.5A.5.5 0 0 0 2 2.5v7a.5.5 0 0 0 .5.5h7a.5.5 0 0 0 .5-.5V7" />
      <path d="M7 2h3v3" />
      <path d="M10 2L5.5 6.5" />
    </svg>
  );
}

const COMANDA_URL = "https://pase-comanda.vercel.app";
const MESA_URL    = "https://mesa-orpin.vercel.app";
const PASE_URL    = "https://pase-yndx.vercel.app";
const ADMIN_URL   = "https://pase-admin-console.vercel.app";
const BOT_IG_URL  = "https://pase-instagram-bot.vercel.app";

interface SistemaCard {
  nombre: string;
  descripcion: string;
  url: string;
  externa: boolean;
  icono: string;
  accentBg: string;
  accentText: string;
  badge?: string;
}

const SISTEMAS: { seccion: string; items: SistemaCard[] }[] = [
  {
    seccion: "Operación diaria",
    items: [
      {
        nombre: "COMANDA",
        descripcion: "Punto de venta — tomá pedidos en salón y mostrador, cobrá y gestioná mesas.",
        url: COMANDA_URL,
        externa: true,
        icono: "📱",
        accentBg: "#EAF3FB",
        accentText: "#1A3A5E",
        badge: "POS",
      },
      {
        nombre: "MESA",
        descripcion: "Gestión de reservas, plano del salón y disponibilidad en tiempo real.",
        url: MESA_URL,
        externa: true,
        icono: "🗺️",
        accentBg: "#E6F4EE",
        accentText: "#14532D",
        badge: "Reservas",
      },
      {
        nombre: "Pantalla de Cocina",
        descripcion: "KDS — vista de órdenes por estado para el equipo de cocina.",
        url: `${COMANDA_URL}/kds`,
        externa: true,
        icono: "👨‍🍳",
        accentBg: "#FFF8E6",
        accentText: "#92400E",
        badge: "KDS",
      },
    ],
  },
  {
    seccion: "Gestión & Reportes",
    items: [
      {
        nombre: "PASE — Back-Office",
        descripcion: "EERR, RRHH, Caja, Conciliaciones, Facturas y todo el historial financiero.",
        url: PASE_URL,
        externa: true,
        icono: "📊",
        accentBg: "#EAF3FB",
        accentText: "#1A3A5E",
        badge: "Gestión",
      },
      {
        nombre: "Bot IA Diagnóstico",
        descripcion: "Asistente inteligente que lee la base de datos y resuelve dudas al instante.",
        url: PASE_URL,
        externa: true,
        icono: "🧠",
        accentBg: "#F3E8FF",
        accentText: "#581C87",
        badge: "IA",
      },
      {
        nombre: "Admin Console",
        descripcion: "Superadmin — gestión de tenants, backups, configuración global del sistema.",
        url: ADMIN_URL,
        externa: true,
        icono: "🛡️",
        accentBg: "#FEF3C7",
        accentText: "#92400E",
        badge: "Admin",
      },
    ],
  },
  {
    seccion: "Para tus clientes",
    items: [
      {
        nombre: "Menú Digital",
        descripcion: "Carta interactiva vía QR — tus clientes ven precios, fotos y pueden pedir.",
        url: `${COMANDA_URL}/settings/menu-qr`,
        externa: true,
        icono: "📋",
        accentBg: "#F0FDF4",
        accentText: "#166534",
        badge: "Público",
      },
      {
        nombre: "Reservas Online",
        descripcion: "Página pública para que tus clientes hagan reservas sin llamarte.",
        url: MESA_URL,
        externa: true,
        icono: "📅",
        accentBg: "#EEF2FF",
        accentText: "#3730A3",
        badge: "Público",
      },
      {
        nombre: "Bot Instagram",
        descripcion: "Responde mensajes de clientes en Instagram con IA — consultas, reservas y más.",
        url: BOT_IG_URL,
        externa: true,
        icono: "📸",
        accentBg: "#FCE7F3",
        accentText: "#9D174D",
        badge: "IG",
      },
    ],
  },
  {
    seccion: "Configuración",
    items: [
      {
        nombre: "Catálogo",
        descripcion: "Productos, grupos, modificadores, precios y disponibilidad.",
        url: `${COMANDA_URL}/catalogo`,
        externa: true,
        icono: "🗂️",
        accentBg: "var(--pase-bg-soft)",
        accentText: "var(--pase-text-muted)",
      },
      {
        nombre: "Ajustes COMANDA",
        descripcion: "Locales, medios de pago, impresoras, AFIP, integraciones y permisos.",
        url: `${COMANDA_URL}/settings`,
        externa: true,
        icono: "⚙️",
        accentBg: "var(--pase-bg-soft)",
        accentText: "var(--pase-text-muted)",
      },
      {
        nombre: "Ajustes PASE",
        descripcion: "Usuarios, roles, categorías contables y configuración general.",
        url: "/ajustes",
        externa: false,
        icono: "🔧",
        accentBg: "var(--pase-bg-soft)",
        accentText: "var(--pase-text-muted)",
      },
    ],
  },
];

export default function Hub() {
  return (
    <PageContainer>
      {/* Header */}
      <div style={{ marginBottom: 32 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
          <span style={{
            display: "inline-block",
            width: 8, height: 8,
            borderRadius: "50%",
            background: "var(--pase-gold)",
          }} />
          <span style={{ fontSize: "var(--pase-fs-sm)", fontWeight: 500, letterSpacing: "var(--pase-ls-overline)", textTransform: "uppercase", color: "var(--pase-text-muted)" }}>
            Ecosistema
          </span>
        </div>
        <h1 style={{ fontSize: "var(--pase-fs-xl)", fontWeight: 600, color: "var(--pase-text)", letterSpacing: "var(--pase-ls-tight)", margin: 0, lineHeight: 1.2 }}>
          pase<span style={{ color: "var(--pase-gold)" }}>.</span>
        </h1>
        <p style={{ fontSize: "var(--pase-fs-base)", color: "var(--pase-text-muted)", marginTop: 4, marginBottom: 0 }}>
          Todos tus sistemas en un lugar. Tocá cualquier card para ingresar.
        </p>
      </div>

      {/* Secciones */}
      <div style={{ display: "flex", flexDirection: "column", gap: 32 }}>
        {SISTEMAS.map((seccion) => (
          <section key={seccion.seccion}>
            <h2 style={{
              fontSize: "var(--pase-fs-sm)",
              fontWeight: 500,
              textTransform: "uppercase",
              letterSpacing: "var(--pase-ls-overline)",
              color: "var(--pase-text-muted)",
              margin: "0 0 12px",
              paddingBottom: 8,
              borderBottom: "0.5px solid var(--pase-border)",
            }}>
              {seccion.seccion}
            </h2>
            <div style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
              gap: 12,
            }}>
              {seccion.items.map((s) => (
                <SistemaCardItem key={s.nombre} sistema={s} />
              ))}
            </div>
          </section>
        ))}
      </div>

      {/* Footer */}
      <div style={{ marginTop: 48, paddingTop: 16, borderTop: "0.5px solid var(--pase-border)", display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
        <span style={{ fontSize: "var(--pase-fs-xs)", color: "var(--pase-text-muted)" }}>
          Todos los sistemas comparten la misma base de datos en tiempo real.
        </span>
        <span style={{ fontSize: "var(--pase-fs-xs)", color: "var(--pase-text-muted)" }}>
          pase<span style={{ color: "var(--pase-gold)" }}>.</span> ecosistema gastronómico
        </span>
      </div>
    </PageContainer>
  );
}

function SistemaCardItem({ sistema }: { sistema: SistemaCard }) {
  const isExternal = sistema.externa;

  const cardStyle: React.CSSProperties = {
    display: "flex",
    flexDirection: "column",
    gap: 10,
    padding: "16px",
    background: "var(--pase-bg)",
    border: "0.5px solid var(--pase-border)",
    borderRadius: "var(--pase-radius-card)",
    boxShadow: "var(--pase-shadow-sm)",
    cursor: "pointer",
    textDecoration: "none",
    color: "inherit",
    transition: `box-shadow var(--pase-duration-fast) var(--pase-ease-out),
                 transform var(--pase-duration-fast) var(--pase-ease-out),
                 border-color var(--pase-duration-fast)`,
  };

  const content = (
    <>
      {/* Icono + badge */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between" }}>
        <div style={{
          width: 44, height: 44,
          borderRadius: 12,
          background: sistema.accentBg,
          display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: 22,
          flexShrink: 0,
        }}>
          {sistema.icono}
        </div>
        {sistema.badge && (
          <span style={{
            fontSize: "var(--pase-fs-xs)",
            fontWeight: 500,
            padding: "2px 8px",
            borderRadius: "var(--pase-radius-pill)",
            background: sistema.accentBg,
            color: sistema.accentText,
            letterSpacing: "0.04em",
          }}>
            {sistema.badge}
          </span>
        )}
      </div>

      {/* Texto */}
      <div style={{ flex: 1 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 5, marginBottom: 4 }}>
          <span style={{ fontSize: "var(--pase-fs-md)", fontWeight: 600, color: "var(--pase-text)", letterSpacing: "var(--pase-ls-snug)" }}>
            {sistema.nombre}
          </span>
          {isExternal && (
            <span style={{ color: "var(--pase-text-muted)", flexShrink: 0, lineHeight: 1 }}>
              <IconExternal />
            </span>
          )}
        </div>
        <p style={{ fontSize: "var(--pase-fs-base)", color: "var(--pase-text-muted)", margin: 0, lineHeight: 1.5 }}>
          {sistema.descripcion}
        </p>
      </div>

      {/* CTA */}
      <div style={{
        fontSize: "var(--pase-fs-sm)",
        fontWeight: 500,
        color: "var(--pase-celeste)",
        letterSpacing: "0.02em",
        marginTop: 2,
      }}>
        {isExternal ? "Abrir →" : "Ir →"}
      </div>
    </>
  );

  if (isExternal) {
    return (
      <a
        href={sistema.url}
        target="_blank"
        rel="noopener noreferrer"
        style={cardStyle}
        onMouseEnter={(e) => {
          const el = e.currentTarget;
          el.style.boxShadow = "var(--pase-shadow-md)";
          el.style.transform = "translateY(-2px)";
          el.style.borderColor = "var(--pase-celeste)";
        }}
        onMouseLeave={(e) => {
          const el = e.currentTarget;
          el.style.boxShadow = "var(--pase-shadow-sm)";
          el.style.transform = "translateY(0)";
          el.style.borderColor = "var(--pase-border)";
        }}
      >
        {content}
      </a>
    );
  }

  return (
    <a
      href={sistema.url}
      style={cardStyle}
      onMouseEnter={(e) => {
        const el = e.currentTarget;
        el.style.boxShadow = "var(--pase-shadow-md)";
        el.style.transform = "translateY(-2px)";
        el.style.borderColor = "var(--pase-celeste)";
      }}
      onMouseLeave={(e) => {
        const el = e.currentTarget;
        el.style.boxShadow = "var(--pase-shadow-sm)";
        el.style.transform = "translateY(0)";
        el.style.borderColor = "var(--pase-border)";
      }}
    >
      {content}
    </a>
  );
}
