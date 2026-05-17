// Registry de widgets disponibles. Cada widget se registra acá.
//
// Para agregar un widget nuevo:
//   1. Crear el componente en src/dashboards/widgets/MiWidget.tsx
//   2. Importarlo y agregarlo al array `WIDGETS` con su metadata.
//   3. Listo — aparece automáticamente en la UI de Settings → Dashboards
//      para los roles que tenga en `rolesPermitidos`.

import type { WidgetDefinition } from "../types";
import { TareasPineadasWidget } from "./TareasPineadasWidget";
import { FacturasVencidasWidget } from "./FacturasVencidasWidget";
import { SaldoCajaWidget } from "./SaldoCajaWidget";
import { VentasHoyWidget } from "./VentasHoyWidget";

export const WIDGETS: WidgetDefinition[] = [
  {
    id: "tareas_pineadas",
    title: "Tareas y mensajes",
    description: "Tareas y mensajes pineados por el dueño para este usuario o su rol.",
    rolesPermitidos: ["dueno", "admin", "encargado", "compras", "cajero", "superadmin"],
    size: "md",
    render: (ctx) => <TareasPineadasWidget ctx={ctx} />,
  },
  {
    id: "facturas_vencidas",
    title: "Facturas vencidas",
    description: "Facturas no pagadas con vencimiento ya pasado. Link directo al pago.",
    rolesPermitidos: ["dueno", "admin", "compras"],
    size: "md",
    render: (ctx) => <FacturasVencidasWidget ctx={ctx} />,
  },
  {
    id: "saldo_caja",
    title: "Saldos de caja",
    description: "Saldo de cada cuenta del local (efectivo, MP, banco) en tiempo real.",
    rolesPermitidos: ["dueno", "admin", "encargado", "cajero"],
    size: "md",
    render: (ctx) => <SaldoCajaWidget ctx={ctx} />,
  },
  {
    id: "ventas_hoy",
    title: "Ventas hoy",
    description: "Total facturado + cantidad de ventas registradas hoy.",
    rolesPermitidos: ["dueno", "admin", "encargado", "cajero"],
    size: "sm",
    render: (ctx) => <VentasHoyWidget ctx={ctx} />,
  },
  // TODO Sesión 2: agregar más widgets
  //   - alertas_prioritarias (cross-rol)
  //   - facturas_por_vencer (próximos 7 días)
  //   - top_proveedores_mes
  //   - mesas_activas (comanda)
  //   - logbook_resumen (manager_logbook)
  //   - objetivos_mes (con tabla nueva)
];

export function findWidget(id: string): WidgetDefinition | undefined {
  return WIDGETS.find((w) => w.id === id);
}

export function widgetsParaRol(rol: string): WidgetDefinition[] {
  return WIDGETS.filter((w) => w.rolesPermitidos.includes(rol as never));
}
