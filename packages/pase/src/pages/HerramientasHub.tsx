import { useState, lazy, Suspense } from "react";
import { useNavigate } from "react-router-dom";
import type { Usuario, Local } from "../types";
import { tienePermiso } from "../lib/auth";
import { Modal, PageHeader, FolderIcon, DocumentIcon, AlertIcon, UploadIcon, KeyIcon, ReceiptIcon } from "../components/ui";

/**
 * Herramientas Hub — pantalla con cards de herramientas avanzadas.
 *
 * Pedido Lucas 2026-05-18: "que sea herramientas en el sidebar, y que ahí
 * estén importar, lector MP, dashboards, blindaje. Cuando abras veas cuadros
 * y al tocarlos abre una ventana popup con la función".
 *
 * Decisión:
 *   - Las 4 herramientas viven detrás de cards en este hub (en lugar de
 *     dispersas en el sidebar)
 *   - Click → modal grande (90vw x 90vh) con la herramienta embebida
 *   - Cierra con X o ESC
 *
 * Las rutas standalone (/herramientas/importar, etc.) siguen existiendo
 * para compat con el tour de onboarding y bookmarks.
 */

// Lazy: cargar la herramienta solo cuando se abre el modal. Mientras el
// usuario navega el hub sin abrir nada, no descarga ningún chunk pesado.
const Importar = lazy(() => import("./Importar"));
const LectorExtractoMP = lazy(() => import("./LectorExtractoMP"));
const Blindaje = lazy(() => import("./herramientas/Blindaje"));
const SettingsDashboards = lazy(() => import("../dashboards/SettingsDashboards"));
const CodigosManager = lazy(() => import("./CodigosManager"));
// RRHHPage sacado del hub 2026-05-18 — Equipo vive en sec Operación del
// sidebar (Lucas: "equipo pasalo a operación"). La ruta /equipo standalone
// sigue manejándose desde App.tsx.
const ContadorIVA = lazy(() => import("./herramientas/ContadorIVA"));

interface Props {
  user: Usuario;
  locales: Local[];
  localActivo: number | null;
}

type ToolId = "importar" | "lector_mp" | "blindaje" | "ajustes_dashboards" | "codigos_manager" | "contador_iva" | "mensajeria";

interface ToolDef {
  id: ToolId;
  label: string;
  description: string;
  /** Slug usado por tienePermiso(). */
  slug: string;
  /** Ícono SVG line-art (component). */
  Icon: typeof FolderIcon;
  /** Si está set, el card NAVEGA a esa URL en vez de abrir el modal embebido.
   *  Útil para herramientas que necesitan pantalla completa (ej. Mensajería). */
  navigateTo?: string;
}

const TOOLS: ToolDef[] = [
  {
    id: "contador_iva",
    label: "Contador / IVA",
    description: "Libro IVA compras + ventas. Reportes para el contador, exportables a CSV.",
    slug: "contador",
    Icon: ReceiptIcon,
  },
  {
    id: "importar",
    label: "Importar data",
    description: "Subir CSV con proveedores, empleados, conceptos y saldos iniciales.",
    slug: "importar",
    Icon: UploadIcon,
  },
  {
    id: "lector_mp",
    label: "Lector extracto MP",
    description: "Subir el extracto mensual de MercadoPago. La IA lo parsea y agrega los movimientos faltantes.",
    slug: "lector_mp",
    Icon: DocumentIcon,
  },
  {
    id: "ajustes_dashboards",
    label: "Configurar dashboards",
    description: "Definir qué widgets ve cada usuario en su pantalla de Inicio.",
    slug: "ajustes_dashboards",
    Icon: FolderIcon,
  },
  {
    id: "blindaje",
    label: "Blindaje",
    description: "Auditoría de seguridad: integridad de datos, RLS, alertas operativas.",
    slug: "blindaje",
    Icon: AlertIcon,
  },
  {
    id: "codigos_manager",
    label: "Códigos Manager",
    description: "Códigos rotativos de 6 dígitos para autorizar empleados que necesitan permisos puntuales.",
    slug: "codigos_manager",
    Icon: KeyIcon,
  },
  {
    id: "mensajeria",
    label: "Mensajería 💬",
    description: "Bot de Instagram con memoria. Ver conversaciones, tomar el control y responder como humano.",
    slug: "mensajeria",
    Icon: DocumentIcon,
    navigateTo: "/mensajeria",
  },
];
// "Usuarios COMANDA" eliminado 24-may noche: la gestión vive ahora EN
// COMANDA misma (Sprint COMANDA Autónomo Fase 2.b). Ir a
// pase-comanda.vercel.app → Empleados → Usuarios POS.

export default function HerramientasHub({ user, locales, localActivo }: Props) {
  const navigate = useNavigate();
  const [activeTool, setActiveTool] = useState<ToolId | null>(null);
  const toolsHabilitadas = TOOLS.filter(t => tienePermiso(user, t.slug));

  if (toolsHabilitadas.length === 0) {
    return (
      <div style={{ padding: "0 20px" }}>
        <PageHeader title="Herramientas" subtitle="" />
        <div style={{
          padding: 40, textAlign: "center", color: "var(--pase-text-muted)",
          background: "var(--pase-bg-soft)", borderRadius: 12,
          border: "0.5px solid var(--pase-border)",
        }}>
          No tenés acceso a herramientas. Pedile al dueño que te otorgue permisos.
        </div>
      </div>
    );
  }

  const activeToolDef = activeTool ? TOOLS.find(t => t.id === activeTool) : null;

  return (
    <div style={{ padding: "0 20px" }}>
      <PageHeader
        title="Herramientas"
        subtitle="módulos avanzados de configuración y administración"
        info={
          <>Cada herramienta vive en su propio espacio. Al clickear un cuadro,
          se abre la herramienta para que la uses sin perder el contexto.</>
        }
      />

      {/* Grilla de cards */}
      <div style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
        gap: 16,
        marginTop: 8,
      }}>
        {toolsHabilitadas.map(t => (
          <button
            key={t.id}
            type="button"
            onClick={() => {
              if (t.navigateTo) {
                navigate(t.navigateTo);
              } else {
                setActiveTool(t.id);
              }
            }}
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "flex-start",
              gap: 12,
              padding: 20,
              minHeight: 140,
              background: "var(--pase-bg)",
              border: "0.5px solid var(--pase-border)",
              borderRadius: 14,
              cursor: "pointer",
              textAlign: "left",
              fontFamily: "inherit",
              boxShadow: "var(--pase-shadow-sm)",
              transition: "transform 0.15s ease, border-color 0.2s ease, box-shadow 0.2s ease",
            }}
            onMouseEnter={e => {
              e.currentTarget.style.transform = "translateY(-2px)";
              e.currentTarget.style.borderColor = "var(--pase-border-strong)";
              e.currentTarget.style.boxShadow = "var(--pase-shadow-md)";
            }}
            onMouseLeave={e => {
              e.currentTarget.style.transform = "";
              e.currentTarget.style.borderColor = "var(--pase-border)";
              e.currentTarget.style.boxShadow = "var(--pase-shadow-sm)";
            }}
          >
            <t.Icon size={28} tone="gold" />
            <div style={{
              fontSize: "var(--pase-fs-md)",
              fontWeight: 500,
              color: "var(--pase-text)",
              lineHeight: 1.3,
            }}>
              {t.label}
            </div>
            <div style={{
              fontSize: "var(--pase-fs-sm)",
              color: "var(--pase-text-muted)",
              lineHeight: 1.5,
            }}>
              {t.description}
            </div>
          </button>
        ))}
      </div>

      {/* Modal grande con la herramienta embebida.
          AUDIT F4B#1 / sprint #5: migrado a <Modal> compartido (focus trap,
          Escape, body-scroll lock, role=dialog automáticos). */}
      <Modal
        isOpen={!!activeToolDef}
        onClose={() => setActiveTool(null)}
        title={activeToolDef?.label || ""}
        maxWidth={1400}
      >
        <Suspense fallback={<div style={{ padding: 40, color: "var(--pase-text-muted)" }}>Cargando…</div>}>
          {activeToolDef?.id === "importar" && (
            <Importar user={user} locales={locales} localActivo={localActivo} />
          )}
          {activeToolDef?.id === "lector_mp" && (
            <LectorExtractoMP user={user} locales={locales} localActivo={localActivo} />
          )}
          {activeToolDef?.id === "blindaje" && (
            <Blindaje user={user} locales={locales} localActivo={localActivo} />
          )}
          {activeToolDef?.id === "ajustes_dashboards" && user.tenant_id && (
            <SettingsDashboards tenantId={user.tenant_id} />
          )}
          {activeToolDef?.id === "codigos_manager" && (
            <CodigosManager user={user} />
          )}
          {activeToolDef?.id === "contador_iva" && (
            <ContadorIVA user={user} locales={locales} localActivo={localActivo} />
          )}
        </Suspense>
      </Modal>
    </div>
  );
}
