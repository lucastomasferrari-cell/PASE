/**
 * onboardingTours.ts — tours guiados por PERMISO (no por rol).
 *
 * Diseño 2026-05-17 (rediseño por feedback Lucas):
 *
 *   1. CADA módulo/permiso tiene su mini-tour específico (ej: 'caja' enseña
 *      a cargar movimientos, 'compras' a cargar facturas, etc).
 *   2. Al entrar a /inicio por primera vez se calculan qué permisos tiene
 *      el user y se le muestran SOLO los tours de esos permisos, en orden.
 *   3. Cada permiso se marca como "tour visto" individualmente en localStorage.
 *      Si el dueño le agrega un permiso nuevo más adelante, la próxima vez
 *      que entre se le dispara solo el tour del permiso nuevo.
 *
 * Esto reemplaza el modelo viejo (3 tours por rol) que se rompe cuando los
 * permisos no se corresponden 1:1 con un rol nominal — caso típico en
 * PASE donde casi todos los users son "encargado" con matriz custom.
 */

import { driver, type DriveStep } from "driver.js";
import "driver.js/dist/driver.css";

// ─── Tour de bienvenida (siempre primero) ─────────────────────────────
const BIENVENIDA: DriveStep[] = [
  {
    popover: {
      title: "¡Bienvenido a PASE!",
      description: `Te damos un tour rápido por las funciones que tenés habilitadas.<br /><br />
        Podés saltarlo en cualquier momento o repetirlo después desde <strong>Ajustes → Ver tour de bienvenida</strong>.`,
      side: "over", align: "center",
    },
  },
  {
    element: "[data-tour='sidebar-local']",
    popover: {
      title: "Sucursal activa",
      description: `Si tenés más de una sucursal, elegís acá sobre cuál estás trabajando. Todo lo que veas o cargues se asocia a esa sucursal.`,
      side: "right",
    },
  },
  {
    element: "[data-tour='sidebar-nav']",
    popover: {
      title: "Tus módulos",
      description: `Estos son los módulos a los que tenés acceso. Vamos a recorrer cada uno brevemente.`,
      side: "right",
    },
  },
];

// ─── Mini-tours por permiso ─────────────────────────────────────────────
// Clave = slug del permiso (igual que en MODULOS). Si un permiso no tiene
// tour, simplemente se skipea (no rompe).

const TOURS_POR_PERMISO: Record<string, DriveStep[]> = {
  inicio: [],  // ya incluido en BIENVENIDA

  caja: [
    {
      popover: {
        title: "💰 Caja — saldos y movimientos",
        description: `Acá ves los saldos de tus cuentas (Caja Efectivo, Caja Chica, MercadoPago, etc) y todos los movimientos.<br /><br />
          Cargás ingresos y egresos manuales con el botón <strong>+ Movimiento</strong>, y transferís entre cuentas con <strong>↔ Transferir</strong>.<br /><br />
          La mayoría de los movimientos se generan automático al cargar ventas, facturas o gastos.`,
        side: "over", align: "center",
      },
    },
  ],

  ventas: [
    {
      popover: {
        title: "📈 Ventas — cierres del día",
        description: `Cargás los cierres de venta por turno (almuerzo/cena) con el botón <strong>+ Cargar venta</strong>. También importás cierres desde Maxirest.<br /><br />
          Las ventas en efectivo generan automáticamente un movimiento en Caja. Las de tarjeta/MP se registran cuando llega la liquidación.`,
        side: "over", align: "center",
      },
    },
  ],

  compras: [
    {
      popover: {
        title: "📄 Compras — facturas y remitos",
        description: `Cargás facturas de proveedores con <strong>+ Cargar factura</strong> (manual) o usando <strong>Lector IA</strong> (subís foto/PDF y se autocompleta).<br /><br />
          Las compras informales sin factura las cargás como <strong>Remitos</strong>. Después podés vincularlas a la factura cuando llega.<br /><br />
          Filtrá por Pendientes / Vencidas / Pagadas con las pills de la derecha.`,
        side: "over", align: "center",
      },
    },
  ],

  gastos: [
    {
      popover: {
        title: "💸 Gastos — fijos y variables",
        description: `Cargás gastos del día (servicios, sueldos pagados, alquiler, etc) con <strong>+ Cargar Gasto</strong>.<br /><br />
          Cada gasto genera automáticamente un movimiento en Caja descontando el saldo de la cuenta elegida.<br /><br />
          Tipos: fijos / variables / publicidad / comisiones / impuestos.`,
        side: "over", align: "center",
      },
    },
  ],

  negocio: [
    {
      popover: {
        title: "🎯 Negocio — vista ejecutiva",
        description: `Tu pantalla del día como dueño. Acá ves:<br /><br />
          <strong>Punto de equilibrio</strong>: cuánto te falta facturar para cubrir fijos.<br />
          <strong>Objetivo de facturación</strong>: progreso vs meta mensual.<br />
          <strong>Ventas última semana</strong>: tendencia con sparkline.<br />
          <strong>Ranking de sucursales</strong>: cuál vende más.<br /><br />
          Métricas honestas en cualquier momento del mes — sin los espejismos de mid-month del EERR.`,
        side: "over", align: "center",
      },
    },
  ],

  finanzas: [
    {
      popover: {
        title: "📊 Finanzas — análisis profundo",
        description: `Ventas mes a mes, días que más vendés, comparativas entre sucursales y vencimientos próximos.<br /><br />
          Acá hacés el análisis tipo "¿qué pasó esta semana?" o "¿por qué bajó el mes?".`,
        side: "over", align: "center",
      },
    },
  ],

  objetivos: [
    {
      popover: {
        title: "🎯 Objetivos — metas del mes",
        description: `Definí mes a mes lo que querés alcanzar: facturación, costos fijos, margen contribución, CMV, etc.<br /><br />
          Cada objetivo es opcional. Lo que cargues alimenta los widgets del dashboard (punto de equilibrio, % de avance, etc).`,
        side: "over", align: "center",
      },
    },
  ],

  eerr: [
    {
      popover: {
        title: "📊 Reportes — Estado de Resultados",
        description: `El EERR mensual completo: ventas, CMV, gastos por categoría, rentabilidad neta. Base devengada (no caja).<br /><br />
          Útil para análisis a fin de mes. Podés comparar contra meses anteriores y exportar a Excel.`,
        side: "over", align: "center",
      },
    },
  ],

  rrhh: [
    {
      popover: {
        title: "👥 Equipo — empleados y nómina",
        description: `Gestionás empleados (alta, sueldo, vacaciones), cargás novedades del mes y liquidás sueldos.<br /><br />
          Los pagos de sueldo generan movimientos en Caja automático.`,
        side: "over", align: "center",
      },
    },
  ],

  contador: [
    {
      popover: {
        title: "🧾 Contador / IVA",
        description: `Libro IVA Compras y Ventas mensual. Exportable a CSV para pasarle al contador.`,
        side: "over", align: "center",
      },
    },
  ],

  blindaje: [
    {
      popover: {
        title: "🛡 Blindaje",
        description: `Auditoría de seguridad: chequea integridad de los datos, RLS, y alertas de operaciones sospechosas.`,
        side: "over", align: "center",
      },
    },
  ],

  importar: [
    {
      popover: {
        title: "⬇ Importar data",
        description: `Si venís de otro sistema, subí tus proveedores, empleados y conceptos desde Excel/CSV. Hay plantillas para descargar.`,
        side: "over", align: "center",
      },
    },
  ],

  ajustes_dashboards: [
    {
      popover: {
        title: "⚙ Configurar dashboards",
        description: `Elegís qué widgets ve cada empleado en su pantalla de inicio. El cajero ve saldos y ventas del día, el de compras ve facturas vencidas, vos ves todo.`,
        side: "over", align: "center",
      },
    },
  ],

  ajustes: [
    {
      popover: {
        title: "⚙ Ajustes",
        description: `Configuraciones globales: categorías custom, medios de cobro, puestos del equipo. Lo que definís acá se propaga a todas las pantallas.`,
        side: "over", align: "center",
      },
    },
  ],

  usuarios: [
    {
      popover: {
        title: "👤 Usuarios",
        description: `Creás usuarios para tu equipo y les asignás exactamente los permisos que querés que tengan. Sin roles predefinidos — vos decidís qué puede hacer cada uno.`,
        side: "over", align: "center",
      },
    },
  ],
};

// ─── Tour de cierre ─────────────────────────────────────────────────────
const CIERRE: DriveStep[] = [
  {
    popover: {
      title: "¿Dudas sobre algo?",
      description: `Cuando veas el ícono ☼ dorado al lado de un título o campo, pasá el mouse para leer la explicación contextual.<br /><br />
        Cualquier duda más profunda, escribime.`,
      side: "over", align: "center",
    },
  },
  {
    popover: {
      title: "¡Listo! 🎉",
      description: `Ya viste lo esencial. Para repetir este tour cuando quieras: <strong>Ajustes → Ver tour de bienvenida</strong>.<br /><br />
        Si te asignan permisos nuevos más adelante, la próxima vez que entres te vamos a mostrar solo esos.`,
      side: "over", align: "center",
    },
  },
];

// ─── Storage helpers ───────────────────────────────────────────────────
function getSeenPermisos(userId: number): Set<string> {
  try {
    const raw = localStorage.getItem(`pase_onboarding_seen_${userId}`);
    if (!raw) return new Set();
    return new Set(JSON.parse(raw) as string[]);
  } catch { return new Set(); }
}

function setSeenPermisos(userId: number, seen: Set<string>) {
  localStorage.setItem(`pase_onboarding_seen_${userId}`, JSON.stringify([...seen]));
}

// Marker especial para "vio la bienvenida + cierre" (independiente de permisos).
const KEY_BIENVENIDA = "__bienvenida__";

/**
 * Lanza el tour del usuario. Calcula qué tours mostrar según:
 *   - permisos: lista de slugs del user (de getPermisos)
 *   - opts.force: si TRUE, ignora el flag de "ya visto" (botón manual).
 *
 * Comportamiento:
 *   1. Si es primera vez → bienvenida + tours de TODOS los permisos + cierre.
 *   2. Si entró antes pero tiene permisos NUEVOS → solo bienvenida-cortita
 *      ("agregaron permisos nuevos") + tours de los permisos no vistos.
 *   3. Si todos los permisos ya fueron vistos → no hace nada (a menos
 *      que force=true, que muestra todo).
 */
export function lanzarTour(
  permisos: string[],
  userId: number,
  opts: { force?: boolean } = {},
): void {
  const seen = opts.force ? new Set<string>() : getSeenPermisos(userId);
  const vioBienvenida = seen.has(KEY_BIENVENIDA);
  const permisosNuevos = permisos.filter(p => !seen.has(p));

  // Si ya vio todo y no es force, no hacemos nada.
  if (vioBienvenida && permisosNuevos.length === 0 && !opts.force) return;

  const steps: DriveStep[] = [];

  if (!vioBienvenida || opts.force) {
    steps.push(...BIENVENIDA);
  } else {
    // Bienvenida-cortita para permisos nuevos.
    steps.push({
      popover: {
        title: "🆕 Permisos nuevos",
        description: `Te asignaron permisos nuevos desde la última vez que entraste. Vamos a mostrarte rápido qué hacés en cada uno.`,
        side: "over", align: "center",
      },
    });
  }

  // Tours por permiso (en orden de slugs)
  for (const slug of permisosNuevos.length > 0 ? permisosNuevos : permisos) {
    const tour = TOURS_POR_PERMISO[slug];
    if (tour && tour.length > 0) steps.push(...tour);
  }

  // Cierre solo si es la primera vez (o force).
  if (!vioBienvenida || opts.force) {
    steps.push(...CIERRE);
  }

  if (steps.length === 0) return;

  const d = driver({
    showProgress: true,
    progressText: "{{current}} de {{total}}",
    nextBtnText: "Siguiente →",
    prevBtnText: "← Anterior",
    doneBtnText: "Listo",
    overlayOpacity: 0.65,
    steps,
    onDestroyed: () => {
      // Marcar bienvenida + todos los permisos del user como vistos.
      const updated = new Set(seen);
      updated.add(KEY_BIENVENIDA);
      for (const p of permisos) updated.add(p);
      setSeenPermisos(userId, updated);
    },
  });
  d.drive();
}

/** Resetea TODO el progreso del onboarding del user. */
export function resetTour(userId: number): void {
  localStorage.removeItem(`pase_onboarding_seen_${userId}`);
}
