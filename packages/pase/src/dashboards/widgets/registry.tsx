// Registry de widgets disponibles. Cada widget se registra acá.
//
// Para agregar un widget nuevo:
//   1. Crear el componente en src/dashboards/widgets/MiWidget.tsx
//   2. Importarlo y agregarlo al array `WIDGETS` con su metadata.
//   3. Listo — aparece automáticamente en la UI de Settings → Dashboards
//      para los usuarios que tengan al menos uno de los permisos en
//      `permisosRequeridos`. Si el array está vacío `[]`, el widget es
//      cross-rol (lo ven todos los autenticados, p.ej. Tareas y mensajes).
//
// Dueño/admin/superadmin ven SIEMPRE todos los widgets (short-circuit en
// `tienePermiso`).

import type { WidgetDefinition } from "../types";
import { TareasPineadasWidget } from "./TareasPineadasWidget";
import { FacturasVencidasWidget } from "./FacturasVencidasWidget";
import { FacturasPorVencerWidget } from "./FacturasPorVencerWidget";
import { SaldoCajaWidget } from "./SaldoCajaWidget";
import { VentasHoyWidget } from "./VentasHoyWidget";
import { VentasSemanaWidget } from "./VentasSemanaWidget";
import { ComparativaSucursalesWidget } from "./ComparativaSucursalesWidget";
import { ObjetivosMesWidget } from "./ObjetivosMesWidget";
import { PuntoEquilibrioWidget } from "./PuntoEquilibrioWidget";
import { UltimosOverridesWidget } from "./UltimosOverridesWidget";
import { ProximoPasoWidget } from "./ProximoPasoWidget";

export const WIDGETS: WidgetDefinition[] = [
  // ─── Cross-rol ─────────────────────────────────────────────────────────
  {
    id: "proximo_paso",
    title: "Tu próximo paso",
    description: "Recorrido guiado de las pantallas principales. Va sugiriendo qué explorar a continuación basado en lo que ya viste.",
    permisosRequeridos: [],  // cross-rol — útil para todos los empleados nuevos
    size: "md",
    render: (ctx) => <ProximoPasoWidget ctx={ctx} />,
  },
  {
    id: "tareas_pineadas",
    title: "Tareas y mensajes",
    description: "Tareas y mensajes pineados por el dueño para este usuario o su rol.",
    permisosRequeridos: [],  // cross-rol — todos los autenticados
    size: "md",
    render: (ctx) => <TareasPineadasWidget ctx={ctx} />,
  },

  // ─── Operación (caja / ventas) ─────────────────────────────────────────
  {
    id: "saldo_caja",
    title: "Saldos de caja",
    description: "Saldo de cada cuenta del local (efectivo, MP, banco) en tiempo real.",
    permisosRequeridos: ["caja"],
    size: "md",
    render: (ctx) => <SaldoCajaWidget ctx={ctx} />,
  },
  {
    id: "ventas_hoy",
    title: "Ventas hoy",
    description: "Total facturado + cantidad de ventas registradas hoy.",
    permisosRequeridos: ["ventas", "caja"],
    size: "sm",
    render: (ctx) => <VentasHoyWidget ctx={ctx} />,
  },
  {
    id: "ventas_semana",
    title: "Ventas — últimos 7 días",
    description: "Tendencia de ventas con sparkline + variación vs semana previa.",
    permisosRequeridos: ["ventas", "negocio", "finanzas"],
    size: "md",
    render: (ctx) => <VentasSemanaWidget ctx={ctx} />,
  },

  // ─── Compras ────────────────────────────────────────────────────────────
  {
    id: "facturas_vencidas",
    title: "Facturas vencidas",
    description: "Facturas no pagadas con vencimiento ya pasado. Link directo al pago.",
    permisosRequeridos: ["compras", "finanzas"],
    size: "md",
    render: (ctx) => <FacturasVencidasWidget ctx={ctx} />,
  },
  {
    id: "facturas_por_vencer",
    title: "Facturas por vencer (7 días)",
    description: "Próximos vencimientos en la semana — ventana de planificación.",
    permisosRequeridos: ["compras", "finanzas"],
    size: "md",
    render: (ctx) => <FacturasPorVencerWidget ctx={ctx} />,
  },

  // ─── Dirección ──────────────────────────────────────────────────────────
  {
    id: "objetivos_mes",
    title: "Objetivo del mes",
    description: "Avance de facturación vs objetivo cargado. Marca si vas en ritmo.",
    permisosRequeridos: ["negocio", "finanzas", "objetivos"],
    size: "md",
    render: (ctx) => <ObjetivosMesWidget ctx={ctx} />,
  },
  {
    id: "punto_equilibrio",
    title: "Punto de equilibrio",
    description: "Cuánto facturaste vs el mínimo para cubrir costos fijos del mes.",
    permisosRequeridos: ["negocio", "finanzas"],
    size: "md",
    render: (ctx) => <PuntoEquilibrioWidget ctx={ctx} />,
  },
  {
    id: "comparativa_sucursales",
    title: "Ranking sucursales",
    description: "Ventas últimos 7 días por sucursal, ranking + barras.",
    permisosRequeridos: ["negocio", "finanzas"],
    size: "md",
    render: (ctx) => <ComparativaSucursalesWidget ctx={ctx} />,
  },

  // ─── Seguridad (admin only) ─────────────────────────────────────────────
  {
    id: "ultimos_overrides",
    title: "Códigos manager usados",
    description: "Log live de empleados que usaron códigos de autorización. Se actualiza al instante via Realtime y highlightea el más reciente.",
    permisosRequeridos: ["codigos_manager"],
    size: "md",
    render: (ctx) => <UltimosOverridesWidget ctx={ctx} />,
  },

  // TODO COMANDA (cuando esté integrado):
  //   - top_productos_mes     (necesita líneas de venta en COMANDA)
  //   - productos_rentables    (necesita líneas + recipe costing)
  //   - horas_pico            (necesita timestamps de tickets)
  //   - mesas_activas          (necesita estado live de mesas COMANDA)
];

export function findWidget(id: string): WidgetDefinition | undefined {
  return WIDGETS.find((w) => w.id === id);
}

/**
 * Filtra los widgets que el usuario puede ver según sus permisos efectivos.
 * - Si el widget tiene `permisosRequeridos: []`, lo ve cualquier autenticado.
 * - Si tiene al menos un permiso requerido, basta con que el user tenga UNO
 *   (any-of).
 * - Dueño/admin/superadmin ven todo (callers usan getPermisos que ya devuelve
 *   la lista completa para ellos).
 */
export function widgetsParaPermisos(permisos: string[]): WidgetDefinition[] {
  const permSet = new Set(permisos);
  return WIDGETS.filter((w) =>
    w.permisosRequeridos.length === 0 ||
    w.permisosRequeridos.some((p) => permSet.has(p))
  );
}

/** @deprecated — usar `widgetsParaPermisos`. Roles nominales no diferencian más. */
export function widgetsParaRol(_rol: string): WidgetDefinition[] {
  return WIDGETS;
}
