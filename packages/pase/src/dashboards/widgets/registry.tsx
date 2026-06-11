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
// SaldoCajaWidget ELIMINADO 24-may noche (Lucas): leakeaba Caja Efectivo
// a encargados en /inicio. Aunque agregamos filtro por cuentas_visibles
// (commit 016d806), Lucas decidió sacar el widget completo. La info de
// saldos vive en /caja, no en el dashboard.
// import { SaldoCajaWidget } from "./SaldoCajaWidget";
import { VentasHoyWidget } from "./VentasHoyWidget";
import { VentasSemanaWidget } from "./VentasSemanaWidget";
import { ComparativaSucursalesWidget } from "./ComparativaSucursalesWidget";
import { EfectivoConsolidadoWidget } from "./EfectivoConsolidadoWidget";
import { ObjetivosMesWidget } from "./ObjetivosMesWidget";
import { PuntoEquilibrioWidget } from "./PuntoEquilibrioWidget";
import { UltimosOverridesWidget } from "./UltimosOverridesWidget";
import { ProximoPasoWidget } from "./ProximoPasoWidget";
import { VentasMesAMesWidget } from "./VentasMesAMesWidget";
import { DiasMasVendidosWidget } from "./DiasMasVendidosWidget";

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
  // saldo_caja ELIMINADO 24-may noche por leak Caja Efectivo a encargados.
  // Los users que ya lo tenían en su dashboard config van a verlo desaparecer
  // (el filtro por permisosRequeridos al renderizar deja afuera widgets
  // que ya no existen).
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
  // Extraídos de la ex-pantalla Finanzas (rediseño 11-jun, fusión con
  // Negocio). La pantalla Negocio los muestra fija; acá quedan disponibles
  // para que cualquier usuario los sume a su Inicio.
  {
    id: "ventas_mes_a_mes",
    title: "Ventas mes a mes",
    description: "Barras de facturación de los últimos 6 meses. El mes actual va parcial.",
    permisosRequeridos: ["negocio", "finanzas"],
    size: "md",
    render: (ctx) => <VentasMesAMesWidget ctx={ctx} />,
  },
  {
    id: "dias_mas_vendidos",
    title: "Días que más se vende",
    description: "Ranking de días de la semana por facturación (últimos 90 días).",
    permisosRequeridos: ["negocio", "finanzas"],
    size: "md",
    render: (ctx) => <DiasMasVendidosWidget ctx={ctx} />,
  },
  {
    id: "efectivo_consolidado",
    title: "Efectivo total (todos los locales)",
    description: "Suma del efectivo (Caja Efectivo) de todos los locales, con desglose por sucursal. Solo dueño/admin.",
    permisosRequeridos: ["finanzas"],
    size: "sm",
    render: (ctx) => <EfectivoConsolidadoWidget ctx={ctx} />,
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
