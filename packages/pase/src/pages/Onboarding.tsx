// Onboarding.tsx — wizard de setup post-creación de tenant (sprint 27-may).
//
// Cierra el gap "sin Lucas un dueño nuevo NO puede arrancar solo": guía paso
// a paso los 5 setup imprescindibles antes de empezar a operar.
//
// Pasos:
//   1. Completar dirección/provincia/localidad del local (en /negocio).
//   2. Crear primer empleado (en /equipo).
//   3. Cargar primer insumo (en COMANDA → Catálogo → Insumos, o importador CSV).
//   4. Definir primer item de menú (en COMANDA → Catálogo → Items).
//   5. Configurar primer canal de venta (en COMANDA → Catálogo → Canales).
//
// Cada paso muestra:
//   - Descripción de qué se hace + por qué importa.
//   - Botón "Abrir esa pantalla" (router push o link externo a COMANDA).
//   - Botón "Ya lo tengo, marcar como completado" (idempotente).
//
// Al cerrar los 5 pasos, botón final "Listo, llevame al panel" → marca
// `completado=true` y redirige a /inicio. Tenants existentes ya tienen todo
// completado por backfill (migration 202605270100) — esta página solo gatea
// onboarding de tenants NUEVOS.

import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { PageHeader } from "../components/ui";
import {
  getOnboardingProgress,
  marcarPasoOnboarding,
  calcularAvance,
  type OnboardingProgress,
  type OnboardingPaso,
} from "../lib/onboardingProgress";
import type { Usuario } from "../types";

interface Props {
  user: Usuario;
}

interface StepDef {
  id: Exclude<OnboardingPaso, "completado">;
  numero: number;
  titulo: string;
  descripcion: string;
  porQue: string;
  cta: { label: string; type: "internal" | "external"; href: string };
}

// URL de COMANDA — sin entorno aparte, hardcode al deploy actual.
// Si en el futuro hay staging, mover a env var.
const COMANDA_URL = "https://pase-comanda.vercel.app";

const STEPS: StepDef[] = [
  {
    id: "datos_local",
    numero: 1,
    titulo: "Completá los datos del local",
    descripcion:
      "Dirección, provincia y localidad. Se usan en facturas, marketplace y en la pantalla de inicio.",
    porQue:
      "Sin estos datos no podés emitir facturas válidas ni aparecer en el directorio del marketplace.",
    cta: { label: "Abrir Negocio", type: "internal", href: "/negocio" },
  },
  {
    id: "primer_empleado",
    numero: 2,
    titulo: "Cargá tu primer empleado",
    descripcion:
      "Nombre, CUIL, sueldo bruto, fecha de ingreso. Después podés sumar el resto.",
    porQue:
      "Sin empleados cargados no podés generar liquidaciones, pagar sueldos ni adelantos.",
    cta: { label: "Abrir Equipo", type: "internal", href: "/equipo" },
  },
  {
    id: "primer_insumo",
    numero: 3,
    titulo: "Cargá tu primer insumo",
    descripcion:
      "Lo que comprás a proveedores: ingredientes, packaging, bebidas. Podés importar de a muchos via CSV.",
    porQue:
      "Los insumos son la base del CMV (Costo de Mercadería Vendida) y permiten que el sistema descuente stock automático al vender.",
    cta: { label: "Abrir Insumos (COMANDA)", type: "external", href: `${COMANDA_URL}/inventario/insumos` },
  },
  {
    id: "primer_item",
    numero: 4,
    titulo: "Definí tu primer item de menú",
    descripcion:
      "Lo que vendés: platos, bebidas, combos. Cada item se compone de uno o más insumos (receta).",
    porQue:
      "Sin items no se puede facturar en el POS ni publicar nada en el marketplace.",
    cta: { label: "Abrir Items (COMANDA)", type: "external", href: `${COMANDA_URL}/catalogo/items` },
  },
  {
    id: "primer_canal",
    numero: 5,
    titulo: "Configurá un canal de venta",
    descripcion:
      "Salón, mostrador, delivery propio, takeaway. Cada item puede tener precio distinto por canal.",
    porQue:
      "El POS te pregunta el canal antes de cobrar — es lo que clasifica cada venta para tus reportes.",
    cta: { label: "Abrir Canales (COMANDA)", type: "external", href: `${COMANDA_URL}/catalogo/canales` },
  },
];

export default function Onboarding({ user }: Props) {
  const navigate = useNavigate();
  const [progress, setProgress] = useState<OnboardingProgress | null>(null);
  const [loading, setLoading] = useState(true);
  const [marcando, setMarcando] = useState<OnboardingPaso | null>(null);
  const [error, setError] = useState<string | null>(null);

  const tenantId = user.tenant_id;

  useEffect(() => {
    if (!tenantId) return;
    let cancelado = false;
    void (async () => {
      const { data, error: e } = await getOnboardingProgress(tenantId);
      if (cancelado) return;
      if (e) setError(e);
      setProgress(data);
      setLoading(false);
    })();
    return () => {
      cancelado = true;
    };
  }, [tenantId]);

  const refrescar = async () => {
    if (!tenantId) return;
    const { data } = await getOnboardingProgress(tenantId);
    setProgress(data);
  };

  const marcarPaso = async (paso: OnboardingPaso) => {
    setMarcando(paso);
    setError(null);
    const { error: e } = await marcarPasoOnboarding(paso);
    setMarcando(null);
    if (e) {
      setError(e);
      return;
    }
    await refrescar();
    if (paso === "completado") {
      // Tras marcar completado, llevar al panel.
      navigate("/inicio", { replace: true });
    }
  };

  if (!tenantId) {
    return (
      <div style={{ padding: 24 }}>
        <PageHeader title="Onboarding" />
        <p style={{ color: "var(--pase-text-muted)" }}>
          Tu usuario no tiene tenant asignado. Hablalo con tu administrador.
        </p>
      </div>
    );
  }

  if (loading) {
    return (
      <div style={{ padding: 24 }}>
        <PageHeader title="Onboarding" />
        <p style={{ color: "var(--pase-text-muted)" }}>Cargando estado…</p>
      </div>
    );
  }

  const { pct, next } = calcularAvance(progress);
  const todosListos = next === null;

  const isHecho = (id: Exclude<OnboardingPaso, "completado">): boolean => {
    if (!progress) return false;
    const key = `paso_${id}` as keyof OnboardingProgress;
    return progress[key] === true;
  };

  return (
    <div style={{ padding: 24, maxWidth: 880, margin: "0 auto" }}>
      <PageHeader
        title="Onboarding"
        info={
          <>
            Esta pantalla te guía por los 5 setup imprescindibles antes de
            empezar a operar. Una vez que los completás, no la vas a ver más.
          </>
        }
      />

      {/* Barra de progreso */}
      <div
        style={{
          background: "var(--pase-bg-elev)",
          border: "0.5px solid var(--pase-border)",
          borderRadius: 12,
          padding: "16px 18px",
          marginBottom: 20,
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "baseline",
            marginBottom: 10,
          }}
        >
          <span style={{ fontSize: 14, color: "var(--pase-text-muted)" }}>
            {todosListos ? "¡Listo!" : `Avance del setup`}
          </span>
          <span
            style={{
              fontSize: 18,
              fontWeight: 500,
              color: pct === 100 ? "var(--pase-success, #2BB673)" : "var(--pase-celeste)",
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {pct}%
          </span>
        </div>
        <div
          style={{
            height: 6,
            background: "rgba(117,170,219,0.15)",
            borderRadius: 999,
            overflow: "hidden",
          }}
        >
          <div
            style={{
              width: `${pct}%`,
              height: "100%",
              background:
                pct === 100 ? "var(--pase-success, #2BB673)" : "var(--pase-celeste)",
              transition: "width 0.4s ease",
            }}
          />
        </div>
      </div>

      {error && (
        <div
          style={{
            background: "rgba(239,68,68,0.1)",
            color: "var(--pase-danger, #EF4444)",
            border: "0.5px solid rgba(239,68,68,0.3)",
            borderRadius: 8,
            padding: "10px 14px",
            marginBottom: 16,
            fontSize: 14,
          }}
        >
          {error}
        </div>
      )}

      {/* Steps */}
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {STEPS.map((step) => {
          const hecho = isHecho(step.id);
          const esNext = next === step.id;
          return (
            <div
              key={step.id}
              style={{
                background: "var(--pase-bg-elev)",
                border: esNext
                  ? "1.5px solid var(--pase-celeste)"
                  : "0.5px solid var(--pase-border)",
                borderRadius: 12,
                padding: 18,
                opacity: hecho ? 0.6 : 1,
                transition: "opacity 0.2s, border 0.2s",
              }}
            >
              <div style={{ display: "flex", gap: 14, alignItems: "flex-start" }}>
                <div
                  style={{
                    width: 32,
                    height: 32,
                    flexShrink: 0,
                    borderRadius: "50%",
                    background: hecho
                      ? "var(--pase-success, #2BB673)"
                      : esNext
                      ? "var(--pase-celeste)"
                      : "rgba(117,170,219,0.2)",
                    color: hecho || esNext ? "white" : "var(--pase-text-muted)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontWeight: 500,
                    fontSize: 14,
                  }}
                >
                  {hecho ? "✓" : step.numero}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <h3
                    style={{
                      margin: 0,
                      fontSize: 16,
                      fontWeight: 500,
                      color: "var(--pase-text)",
                      textDecoration: hecho ? "line-through" : "none",
                    }}
                  >
                    {step.titulo}
                  </h3>
                  <p
                    style={{
                      margin: "6px 0 0 0",
                      fontSize: 13,
                      color: "var(--pase-text-muted)",
                      lineHeight: 1.5,
                    }}
                  >
                    {step.descripcion}
                  </p>
                  <p
                    style={{
                      margin: "6px 0 0 0",
                      fontSize: 12,
                      color: "var(--pase-text-muted)",
                      fontStyle: "italic",
                    }}
                  >
                    {step.porQue}
                  </p>
                  {!hecho && (
                    <div
                      style={{
                        display: "flex",
                        gap: 8,
                        marginTop: 12,
                        flexWrap: "wrap",
                      }}
                    >
                      {step.cta.type === "internal" ? (
                        <button
                          className="btn btn-acc"
                          onClick={() => navigate(step.cta.href)}
                          style={{ fontSize: 13 }}
                        >
                          {step.cta.label}
                        </button>
                      ) : (
                        <a
                          className="btn btn-acc"
                          href={step.cta.href}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{ fontSize: 13, textDecoration: "none" }}
                        >
                          {step.cta.label} ↗
                        </a>
                      )}
                      <button
                        className="btn btn-secondary"
                        disabled={marcando === step.id}
                        onClick={() => void marcarPaso(step.id)}
                        style={{ fontSize: 13 }}
                      >
                        {marcando === step.id ? "Marcando…" : "Ya lo hice"}
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Final: marcar onboarding como completado */}
      <div
        style={{
          marginTop: 24,
          padding: 20,
          background: todosListos
            ? "rgba(43,182,115,0.08)"
            : "var(--pase-bg-elev)",
          border: todosListos
            ? "1px solid rgba(43,182,115,0.3)"
            : "0.5px dashed var(--pase-border)",
          borderRadius: 12,
          textAlign: "center",
        }}
      >
        {todosListos ? (
          <>
            <p
              style={{
                margin: "0 0 12px 0",
                fontSize: 15,
                color: "var(--pase-text)",
              }}
            >
              Completaste todos los pasos. Ya podés empezar a operar.
            </p>
            <button
              className="btn btn-acc"
              disabled={marcando === "completado"}
              onClick={() => void marcarPaso("completado")}
            >
              {marcando === "completado" ? "Finalizando…" : "Listo, llevame al panel"}
            </button>
          </>
        ) : (
          <p
            style={{
              margin: 0,
              fontSize: 13,
              color: "var(--pase-text-muted)",
            }}
          >
            Completá los pasos pendientes para activar el botón final.
          </p>
        )}
      </div>
    </div>
  );
}
