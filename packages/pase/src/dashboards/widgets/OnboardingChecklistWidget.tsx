import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import {
  autodetectarOnboarding,
  marcarPasoOnboarding,
  type OnboardingProgress,
  type OnboardingPaso,
} from "../../lib/onboardingProgress";
import type { WidgetContext } from "../types";

/**
 * OnboardingChecklistWidget — checklist de bienvenida en el Inicio (Tier 3,
 * informe 14-ux-settings-onboarding).
 *
 * Surfacea el progreso del setup (tabla `tenant_onboarding_progress`, los
 * mismos 5 pasos del wizard /onboarding) directamente en el Home, y lo
 * AUTO-completa: al montar llama `fn_onboarding_autodetectar()` que marca
 * cada paso cuyo dato real ya exista (provincia/localidad, empleado activo,
 * insumo, item, canal).
 *
 * Se esconde solo (return null) cuando el tenant ya está configurado:
 *   - `completado = TRUE` (el dueño tocó "Listo, no mostrar más"), o
 *   - los 5 pasos en TRUE.
 * Así un tenant viejo (Neko, backfilled completo) nunca lo ve.
 *
 * Gate por rol: el registry solo filtra por permisos (no por rol), y este
 * widget se registra con `permisosRequeridos: []`. Para que solo lo vea el
 * dueño/admin (es setup del dueño), el gate de rol vive ACÁ adentro:
 * encargado/cajero/compras → return null. Igualmente solo está en los
 * defaults de dueño/admin (ver DEFAULT_WIDGETS_POR_ROL).
 */

// URL de COMANDA — mismo hardcode que Onboarding.tsx (sin entorno aparte).
const COMANDA_URL = "https://pase-comanda.vercel.app";

type PasoId = Exclude<OnboardingPaso, "completado">;

interface StepDef {
  id: PasoId;
  numero: number;
  titulo: string;
  descripcion: string;
  cta: { label: string; type: "internal" | "external"; href: string };
}

// Reusados de Onboarding.tsx (mismos labels/CTAs, descripciones acortadas
// para el formato compacto del widget).
const STEPS: StepDef[] = [
  {
    id: "datos_local",
    numero: 1,
    titulo: "Completá los datos del local",
    descripcion: "Dirección, provincia y localidad. Se usan en facturas y marketplace.",
    cta: { label: "Abrir Negocio", type: "internal", href: "/negocio" },
  },
  {
    id: "primer_empleado",
    numero: 2,
    titulo: "Cargá tu primer empleado",
    descripcion: "Sin empleados no podés liquidar sueldos ni adelantos.",
    cta: { label: "Abrir Equipo", type: "internal", href: "/equipo" },
  },
  {
    id: "primer_insumo",
    numero: 3,
    titulo: "Cargá tu primer insumo",
    descripcion: "Lo que comprás a proveedores — base del CMV y del stock.",
    cta: { label: "Abrir Insumos", type: "external", href: `${COMANDA_URL}/inventario/insumos` },
  },
  {
    id: "primer_item",
    numero: 4,
    titulo: "Definí tu primer item de menú",
    descripcion: "Lo que vendés. Sin items no se puede facturar en el POS.",
    cta: { label: "Abrir Items", type: "external", href: `${COMANDA_URL}/catalogo/items` },
  },
  {
    id: "primer_canal",
    numero: 5,
    titulo: "Configurá un canal de venta",
    descripcion: "Salón, mostrador, delivery. Clasifica cada venta para tus reportes.",
    cta: { label: "Abrir Canales", type: "external", href: `${COMANDA_URL}/catalogo/canales` },
  },
];

function pasosHechos(p: OnboardingProgress | null): Record<PasoId, boolean> {
  return {
    datos_local: p?.paso_datos_local === true,
    primer_empleado: p?.paso_primer_empleado === true,
    primer_insumo: p?.paso_primer_insumo === true,
    primer_item: p?.paso_primer_item === true,
    primer_canal: p?.paso_primer_canal === true,
  };
}

export function OnboardingChecklistWidget({ ctx }: { ctx: WidgetContext }) {
  const navigate = useNavigate();

  // Gate por rol: este widget es setup del dueño. El registry no gatea por
  // rol (solo permisos), así que lo hacemos acá. Solo dueño/admin lo ven.
  const esDuenoOAdmin = ctx.usuario.rol === "dueno" || ctx.usuario.rol === "admin";

  const [progress, setProgress] = useState<OnboardingProgress | null>(null);
  // Solo arrancamos en "loading" si vamos a hacer fetch (dueño/admin). Para el
  // resto no hay carga — evita un setState síncrono dentro del effect.
  const [loading, setLoading] = useState(esDuenoOAdmin);
  const [marcando, setMarcando] = useState<OnboardingPaso | null>(null);

  const cargar = useCallback(async () => {
    const { data } = await autodetectarOnboarding();
    setProgress(data);
    setLoading(false);
  }, []);

  useEffect(() => {
    if (!esDuenoOAdmin) return;
    let cancelado = false;
    void (async () => {
      const { data } = await autodetectarOnboarding();
      if (cancelado) return;
      setProgress(data);
      setLoading(false);
    })();
    return () => {
      cancelado = true;
    };
  }, [esDuenoOAdmin]);

  const marcarPaso = useCallback(
    async (paso: OnboardingPaso) => {
      setMarcando(paso);
      const { error } = await marcarPasoOnboarding(paso);
      setMarcando(null);
      if (error) return;
      // Tras marcar, re-leer (auto-detect + el flag recién marcado).
      await cargar();
    },
    [cargar],
  );

  // No dueño/admin → nunca renderiza (defense-in-depth ante opt-in vía Settings).
  if (!esDuenoOAdmin) return null;

  // Mientras carga el primer fetch, no mostramos nada (evita flash de checklist
  // en tenants completos). El widget solo "aparece" si hay pendientes.
  if (loading) return null;

  const hechos = pasosHechos(progress);
  const totalHechos = Object.values(hechos).filter(Boolean).length;
  const total = STEPS.length;

  // Tenant ya configurado → no molestar (Neko, etc. están completos o backfill).
  if (progress?.completado || totalHechos === total) return null;

  const pct = Math.round((totalHechos / total) * 100);

  return (
    <div style={{ padding: "8px 0" }}>
      {/* Encabezado + barra de progreso */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 12,
          fontSize: "var(--pase-fs-xs)",
          color: "var(--pase-text-muted)",
        }}
      >
        <span style={{ fontVariantNumeric: "tabular-nums" }}>
          {totalHechos} de {total}
        </span>
        <div
          style={{
            flex: 1,
            height: 3,
            background: "rgba(117, 170, 219, 0.15)",
            borderRadius: 999,
          }}
        >
          <div
            style={{
              height: "100%",
              width: `${pct}%`,
              background: "var(--pase-celeste)",
              borderRadius: 999,
              transition: "width 0.3s",
            }}
          />
        </div>
      </div>

      {/* Lista de pasos */}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {STEPS.map((step) => {
          const hecho = hechos[step.id];
          return (
            <div
              key={step.id}
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 10,
                opacity: hecho ? 0.5 : 1,
                transition: "opacity 0.2s",
              }}
            >
              <div
                style={{
                  width: 22,
                  height: 22,
                  flexShrink: 0,
                  borderRadius: "50%",
                  background: hecho
                    ? "var(--pase-success, #2BB673)"
                    : "rgba(117, 170, 219, 0.2)",
                  color: hecho ? "white" : "var(--pase-text-muted)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontWeight: 500,
                  fontSize: "var(--pase-fs-xs)",
                  marginTop: 1,
                }}
              >
                {hecho ? "✓" : step.numero}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    fontSize: "var(--pase-fs-sm)",
                    fontWeight: 500,
                    color: "var(--pase-text)",
                    textDecoration: hecho ? "line-through" : "none",
                    lineHeight: 1.3,
                  }}
                >
                  {step.titulo}
                </div>
                {!hecho && (
                  <>
                    <div
                      style={{
                        fontSize: "var(--pase-fs-xs)",
                        color: "var(--pase-text-muted)",
                        lineHeight: 1.4,
                        marginTop: 2,
                      }}
                    >
                      {step.descripcion}
                    </div>
                    <div
                      style={{
                        display: "flex",
                        gap: 8,
                        marginTop: 6,
                        flexWrap: "wrap",
                      }}
                    >
                      {step.cta.type === "internal" ? (
                        <button
                          type="button"
                          className="btn btn-acc btn-sm"
                          onClick={() => navigate(step.cta.href)}
                          style={{ fontSize: "var(--pase-fs-xs)" }}
                        >
                          {step.cta.label}
                        </button>
                      ) : (
                        <a
                          className="btn btn-acc btn-sm"
                          href={step.cta.href}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{ fontSize: "var(--pase-fs-xs)", textDecoration: "none" }}
                        >
                          {step.cta.label} ↗
                        </a>
                      )}
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        disabled={marcando === step.id}
                        onClick={() => void marcarPaso(step.id)}
                        style={{ fontSize: "var(--pase-fs-xs)" }}
                      >
                        {marcando === step.id ? "Marcando…" : "Ya lo hice"}
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Dismiss — solo dueño/admin (ya gateado arriba) */}
      <div style={{ marginTop: 12, borderTop: "0.5px solid var(--pase-border)", paddingTop: 10 }}>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          disabled={marcando === "completado"}
          onClick={() => void marcarPaso("completado")}
          style={{ fontSize: "var(--pase-fs-xs)", color: "var(--pase-text-muted)" }}
        >
          {marcando === "completado" ? "Guardando…" : "Listo, no mostrar más"}
        </button>
      </div>
    </div>
  );
}
