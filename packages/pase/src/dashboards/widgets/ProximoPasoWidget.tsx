import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { lanzarTour } from "../../lib/onboardingTours";
import { tienePermiso } from "../../lib/auth";
import { CheckIcon, TargetIcon } from "../../components/ui";
import type { WidgetContext } from "../types";

/**
 * ProximoPasoWidget — sugiere el siguiente flujo del onboarding profundo.
 *
 * Lucas pidió 2026-05-18: "onboarding interactivo profundo, tour spotlight
 * ampliado + siguiente paso recomendado".
 *
 * Funciona así:
 *   - Lee localStorage `pase_onboarding_seen_{userId}` para saber qué slugs
 *     ya vio el user
 *   - De la lista ordenada de slugs relevantes a su rol, encuentra el
 *     próximo NO visto
 *   - Muestra una card con título + descripción + botón "Empezar"
 *   - Click → llama lanzarTour() con SOLO ese slug
 *
 * Si vio todo: muestra estado "✓ Completaste el recorrido" con opción a
 * repasar.
 */

// Orden recomendado de exploración para empleados nuevos. Los slugs aquí
// deben existir en TOURS_POR_PERMISO de onboardingTours.ts.
const ORDEN_RECOMENDADO: Array<{ slug: string; titulo: string; descripcion: string }> = [
  { slug: "caja",      titulo: "Explorá Caja",       descripcion: "Cómo ver saldos, cargar movimientos manuales y transferir entre cuentas." },
  { slug: "ventas",    titulo: "Cargá ventas",       descripcion: "El cierre de cada turno. Lo más importante del día a día." },
  { slug: "compras",   titulo: "Subí una factura",   descripcion: "Form manual, lector IA y remitos para compras informales." },
  { slug: "gastos",    titulo: "Registrá un gasto",  descripcion: "Servicios, sueldos, etc. Genera el movimiento de Caja automático." },
  { slug: "rrhh",      titulo: "Conocé Equipo",      descripcion: "Empleados, novedades del mes, liquidaciones, adelantos." },
  { slug: "negocio",   titulo: "Mirá Negocio",       descripcion: "Tu pantalla del día como dueño: punto equilibrio + objetivos + ranking." },
  { slug: "finanzas",  titulo: "Analizá Finanzas",   descripcion: "Ventas mes a mes, días que más vendés, comparativa entre sucursales." },
  { slug: "eerr",      titulo: "Revisá Reportes",    descripcion: "EERR mensual completo. Exportable para tu contador." },
  { slug: "herramientas_hub", titulo: "Hub de Herramientas", descripcion: "Módulos avanzados: Importar, Lector MP, Códigos Manager, etc." },
];

const STORAGE_KEY_PREFIX = "pase_onboarding_seen_";

function leerVistos(userId: number): Set<string> {
  try {
    const raw = localStorage.getItem(`${STORAGE_KEY_PREFIX}${userId}`);
    if (!raw) return new Set();
    return new Set(JSON.parse(raw) as string[]);
  } catch { return new Set(); }
}

interface UsuarioParaPermiso {
  id: number;
  rol: string;
  _permisos?: string[];
}

export function ProximoPasoWidget({ ctx }: { ctx: WidgetContext }) {
  const navigate = useNavigate();
  const [vistos, setVistos] = useState<Set<string>>(new Set());
  const [refrescarTick, setRefrescarTick] = useState(0);

  // Re-leer localStorage cuando termina un tour (otro tab del browser o
  // navegación). Aproximación simple: poll cada vez que cambia refrescarTick.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- sync de estado UI con localStorage externo. Patron correcto: effect lee storage cuando cambia el user o el tick (post-tour).
    setVistos(leerVistos(ctx.usuario.id));
  }, [ctx.usuario.id, refrescarTick]);

  // Listener: cuando localStorage cambia (eg. tour completado), re-leer.
  useEffect(() => {
    function onStorageChange(e: StorageEvent) {
      if (e.key === `${STORAGE_KEY_PREFIX}${ctx.usuario.id}`) {
        setVistos(leerVistos(ctx.usuario.id));
      }
    }
    window.addEventListener("storage", onStorageChange);
    return () => window.removeEventListener("storage", onStorageChange);
  }, [ctx.usuario.id]);

  // También revisar al volver visible la tab (cuando el tour cerró en
  // la misma sesión storage event no dispara).
  useEffect(() => {
    function onVisible() {
      if (document.visibilityState === "visible") {
        setVistos(leerVistos(ctx.usuario.id));
      }
    }
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [ctx.usuario.id]);

  // Construir el usuario fake para tienePermiso. ctx.usuario no tiene _permisos
  // pero la regla en sidebar-nav.ts (los slugs especiales) los maneja por rol.
  const userParaPermiso: UsuarioParaPermiso = {
    id: ctx.usuario.id,
    rol: ctx.usuario.rol,
  };

  // Filtrar orden recomendado: solo slugs con permiso.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const recomendadosVisibles = ORDEN_RECOMENDADO.filter(r => tienePermiso(userParaPermiso as any, r.slug));
  const proximo = recomendadosVisibles.find(r => !vistos.has(r.slug));
  const completos = recomendadosVisibles.length - (proximo ? recomendadosVisibles.indexOf(proximo) : recomendadosVisibles.length);
  const total = recomendadosVisibles.length;

  const lanzarPaso = useCallback((slug: string) => {
    lanzarTour([slug], ctx.usuario.id, navigate, { force: true });
    // Después del tour, marcar que volvimos a leer
    setTimeout(() => setRefrescarTick(t => t + 1), 500);
  }, [ctx.usuario.id, navigate]);

  // Sin recomendados visibles (caso raro): no renderear nada.
  if (recomendadosVisibles.length === 0) return null;

  // Todo visto → estado "completado".
  if (!proximo) {
    return (
      <div style={{ padding: "8px 0" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
          <CheckIcon size={24} tone="gold" />
          <div>
            <div style={{ fontSize: "var(--pase-fs-md)", fontWeight: 500, color: "var(--pase-text)" }}>
              Completaste el recorrido
            </div>
            <div style={{ fontSize: "var(--pase-fs-xs)", color: "var(--pase-text-muted)" }}>
              Visitaste las {total} pantallas principales.
            </div>
          </div>
        </div>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => lanzarPaso(recomendadosVisibles[0]!.slug)}
          style={{ fontSize: "var(--pase-fs-xs)" }}
        >
          Repasar desde el inicio
        </button>
      </div>
    );
  }

  // Hay próximo paso.
  const pasoNum = recomendadosVisibles.indexOf(proximo) + 1;
  return (
    <div style={{ padding: "8px 0" }}>
      {/* Barra de progreso */}
      <div style={{
        display: "flex", alignItems: "center", gap: 8, marginBottom: 12,
        fontSize: "var(--pase-fs-xs)", color: "var(--pase-text-muted)",
      }}>
        <span>Paso {pasoNum} de {total}</span>
        <div style={{ flex: 1, height: 3, background: "rgba(117, 170, 219, 0.15)", borderRadius: 999 }}>
          <div style={{
            height: "100%",
            width: `${(completos / total) * 100}%`,
            background: "var(--pase-celeste)",
            borderRadius: 999,
            transition: "width 0.3s",
          }} />
        </div>
      </div>

      {/* Contenido del paso actual */}
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10, marginBottom: 12 }}>
        <TargetIcon size={20} tone="celeste" />
        <div style={{ flex: 1 }}>
          <div style={{
            fontSize: "var(--pase-fs-md)", fontWeight: 500, color: "var(--pase-text)",
            marginBottom: 4, lineHeight: 1.3,
          }}>
            {proximo.titulo}
          </div>
          <div style={{
            fontSize: "var(--pase-fs-sm)", color: "var(--pase-text-muted)",
            lineHeight: 1.5,
          }}>
            {proximo.descripcion}
          </div>
        </div>
      </div>

      {/* Botones */}
      <div style={{ display: "flex", gap: 8 }}>
        <button
          type="button"
          className="btn btn-acc btn-sm"
          onClick={() => lanzarPaso(proximo.slug)}
          style={{ fontSize: "var(--pase-fs-sm)" }}
        >
          Empezar
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => {
            // Marcar como visto sin lanzar tour (saltea este paso).
            const updated = new Set(vistos);
            updated.add(proximo.slug);
            try {
              localStorage.setItem(`${STORAGE_KEY_PREFIX}${ctx.usuario.id}`, JSON.stringify([...updated]));
            } catch { /* quota */ }
            setVistos(updated);
          }}
          style={{ fontSize: "var(--pase-fs-sm)" }}
        >
          Saltar
        </button>
      </div>
    </div>
  );
}
