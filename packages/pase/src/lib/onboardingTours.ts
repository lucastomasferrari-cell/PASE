/**
 * onboardingTours.ts — tours guiados POR PERMISO y NAVEGABLES.
 *
 * Diseño 2026-05-17 (rediseño por feedback Lucas):
 *
 *   1. CADA módulo/permiso tiene su mini-tour específico.
 *   2. Al entrar a /inicio por primera vez se calculan qué permisos tiene
 *      el user y se le muestran SOLO los tours de esos permisos, en orden.
 *   3. Cada permiso se marca como "tour visto" individualmente en localStorage.
 *      Si el dueño le agrega un permiso nuevo más adelante, la próxima vez
 *      que entre se le dispara solo el tour del permiso nuevo.
 *   4. Los pasos pueden tener `route` opcional — el motor navega antes de
 *      mostrar el step. Ahora el tour TE LLEVA a /caja, /compras, etc y te
 *      muestra los botones reales en vez de modales libres.
 */

import { driver, type DriveStep } from "driver.js";
import "driver.js/dist/driver.css";

// Step interno con metadata adicional (route opcional para navegación).
interface PaseStep {
  route?: string;  // Si != null, navegar acá antes de mostrar el step.
  step: DriveStep;
}

type NavigateFn = (path: string) => void;

// ─── Bienvenida ───────────────────────────────────────────────────────
const BIENVENIDA: PaseStep[] = [
  {
    route: "/inicio",
    step: {
      popover: {
        title: "¡Bienvenido a PASE!",
        description: `Te damos un tour por las funciones que tenés habilitadas.<br /><br />
          Te vamos a llevar por cada pantalla y mostrarte qué hacés en cada una.<br /><br />
          Podés saltarlo o repetirlo desde <strong>Ajustes → Ver tour de bienvenida</strong>.`,
        side: "over", align: "center",
      },
    },
  },
  {
    step: {
      element: "[data-tour='sidebar-local']",
      popover: {
        title: "Sucursal activa",
        description: `Si tenés más de una sucursal, elegís acá sobre cuál estás trabajando. <strong>Todo lo que veas o cargues se asocia a esa sucursal.</strong>`,
        side: "right",
      },
    },
  },
  {
    step: {
      element: "[data-tour='sidebar-nav']",
      popover: {
        title: "Tus módulos",
        description: `Estos son los módulos a los que tenés acceso. Vamos a recorrer cada uno.`,
        side: "right",
      },
    },
  },
];

// ─── Mini-tours por permiso — NAVEGABLES ───────────────────────────────

const TOURS_POR_PERMISO: Record<string, PaseStep[]> = {
  inicio: [],

  caja: [
    {
      route: "/caja",
      step: {
        popover: {
          title: "💰 Caja",
          description: `Acá ves los saldos de tus cuentas y todos los movimientos del local.<br /><br />
            Te llevo a esta pantalla para que veas cómo se ve.`,
          side: "over", align: "center",
        },
      },
    },
    {
      step: {
        // Botón "+ Movimiento" del header
        element: "button.btn.btn-acc",
        popover: {
          title: "+ Movimiento",
          description: `Acá cargás un movimiento manual (ingreso o egreso). La mayoría se generan automático al cargar ventas/gastos/facturas — solo usás esto para ajustes manuales.`,
          side: "bottom",
        },
      },
    },
  ],

  ventas: [
    {
      route: "/ventas",
      step: {
        popover: {
          title: "📈 Ventas",
          description: `Cargás los cierres de venta por turno (almuerzo/cena). Las ventas en efectivo generan automáticamente un movimiento en Caja.`,
          side: "over", align: "center",
        },
      },
    },
  ],

  compras: [
    {
      route: "/compras",
      step: {
        popover: {
          title: "📄 Compras",
          description: `Acá viven las facturas de proveedores. Te muestro cómo se cargan.`,
          side: "over", align: "center",
        },
      },
    },
    {
      step: {
        // Botón "+ Cargar factura"
        element: "button.btn.btn-acc",
        popover: {
          title: "+ Cargar factura",
          description: `Cargás facturas manualmente o usá <strong>Lector IA</strong> (subís foto/PDF y se autocompleta). Compras informales sin factura → cargás como <strong>Remito</strong>.`,
          side: "bottom",
        },
      },
    },
  ],

  gastos: [
    {
      route: "/gastos",
      step: {
        popover: {
          title: "💸 Gastos",
          description: `Cargás gastos del día (servicios, alquiler, etc). Cada gasto genera automáticamente un movimiento en Caja descontando el saldo.`,
          side: "over", align: "center",
        },
      },
    },
  ],

  reservas: [
    {
      route: "/reservas",
      step: {
        popover: {
          title: "📅 Reservas",
          description: `Agenda diaria de reservas tomadas por teléfono o WhatsApp. Cambiás el estado inline (pendiente / confirmada / sentada / cancelada / no vino).`,
          side: "over", align: "center",
        },
      },
    },
  ],

  negocio: [
    {
      route: "/negocio",
      step: {
        popover: {
          title: "🎯 Negocio",
          description: `Tu pantalla del día como dueño. Punto de equilibrio, objetivo del mes, ventas última semana, ranking sucursales y vencimientos.<br /><br />
            Métricas honestas en cualquier momento del mes — sin los espejismos del EERR mid-month.`,
          side: "over", align: "center",
        },
      },
    },
  ],

  finanzas: [
    {
      route: "/finanzas",
      step: {
        popover: {
          title: "📊 Análisis financiero",
          description: `Ventas mes a mes, días que más vendés, comparativas entre sucursales y vencimientos próximos.`,
          side: "over", align: "center",
        },
      },
    },
  ],

  objetivos: [
    {
      route: "/objetivos",
      step: {
        popover: {
          title: "🎯 Objetivos",
          description: `Definí mes a mes lo que querés alcanzar: facturación, costos fijos, margen, CMV, etc.<br /><br />
            Cada indicador es opcional. Lo que cargues alimenta los widgets del dashboard.`,
          side: "over", align: "center",
        },
      },
    },
  ],

  eerr: [
    {
      route: "/reportes",
      step: {
        popover: {
          title: "📊 Reportes",
          description: `El EERR mensual completo: ventas, CMV, gastos por categoría, rentabilidad neta. Base devengada.<br /><br />
            Exportable a CSV para pasarle al contador.`,
          side: "over", align: "center",
        },
      },
    },
  ],

  rrhh: [
    {
      route: "/equipo",
      step: {
        popover: {
          title: "👥 Equipo",
          description: `Empleados, novedades del mes y liquidación de sueldos. Los pagos generan movimientos en Caja automático.`,
          side: "over", align: "center",
        },
      },
    },
  ],

  contador: [
    {
      route: "/herramientas/contador-iva",
      step: {
        popover: {
          title: "🧾 Contador / IVA",
          description: `Libro IVA Compras y Ventas mensual. Exportable a CSV para tu contador.`,
          side: "over", align: "center",
        },
      },
    },
  ],

  blindaje: [
    {
      route: "/herramientas/blindaje",
      step: {
        popover: {
          title: "🛡 Blindaje",
          description: `Auditoría de seguridad: chequea integridad de los datos, RLS, y alertas de operaciones sospechosas.`,
          side: "over", align: "center",
        },
      },
    },
  ],

  // Hub de Herramientas — engloba importar, lector_mp, ajustes_dashboards,
  // blindaje y codigos_manager (que tambien tienen entradas individuales abajo
  // para compat). El caller (DashboardHome/Ajustes) prioriza este hub y
  // SKIPEA los individuales si el user tiene acceso al hub, para no mostrar
  // 6 tours de lo mismo.
  herramientas_hub: [
    {
      route: "/herramientas",
      step: {
        popover: {
          title: "🧰 Herramientas",
          description: `Acá encontrás módulos avanzados detrás de cards: Importar data, Lector extracto MP, Configurar dashboards, Blindaje y Códigos Manager.<br /><br />
            Click en cualquier card y se abre la herramienta sin perder lo que estabas haciendo.`,
          side: "over", align: "center",
        },
      },
    },
  ],

  importar: [
    {
      route: "/herramientas/importar",
      step: {
        popover: {
          title: "⬇ Importar data",
          description: `Si venís de otro sistema, subí tus proveedores, empleados, conceptos y saldos iniciales desde Excel/CSV. Hay plantillas para descargar.`,
          side: "over", align: "center",
        },
      },
    },
  ],

  lector_mp: [
    {
      route: "/herramientas/lector-mp",
      step: {
        popover: {
          title: "🧠 Lector extracto MP",
          description: `Una vez al mes bajás el extracto de MercadoPago y lo subís acá. La IA lo parsea y agrega los movimientos faltantes (lo que la API automática se perdió).`,
          side: "over", align: "center",
        },
      },
    },
  ],

  ajustes_dashboards: [
    {
      route: "/ajustes/dashboards",
      step: {
        popover: {
          title: "⚙ Configurar dashboards",
          description: `Elegís qué widgets ve cada empleado en su pantalla de inicio. El cajero ve saldos y ventas del día, vos ves todo.`,
          side: "over", align: "center",
        },
      },
    },
  ],

  ajustes: [
    {
      route: "/ajustes",
      step: {
        popover: {
          title: "⚙ Ajustes",
          description: `Configuraciones globales: categorías custom, medios de cobro, puestos del equipo. Lo que definís acá se propaga a todas las pantallas.`,
          side: "over", align: "center",
        },
      },
    },
  ],

  usuarios: [
    {
      route: "/usuarios",
      step: {
        popover: {
          title: "👤 Usuarios",
          description: `Creás usuarios para tu equipo y les asignás permisos exactos. Sin roles predefinidos — vos decidís qué puede hacer cada uno.`,
          side: "over", align: "center",
        },
      },
    },
  ],
};

// ─── Cierre ────────────────────────────────────────────────────────────
const CIERRE: PaseStep[] = [
  {
    route: "/inicio",
    step: {
      popover: {
        title: "¿Dudas sobre algo?",
        description: `Cuando veas el ícono ☼ dorado al lado de un título o campo, pasá el mouse para leer la explicación contextual.`,
        side: "over", align: "center",
      },
    },
  },
  {
    step: {
      popover: {
        title: "¡Listo! 🎉",
        description: `Ya viste lo esencial. Para repetir este tour: <strong>Ajustes → Ver tour de bienvenida</strong>.<br /><br />
          Si te asignan permisos nuevos, la próxima vez que entres te mostraremos solo esos.`,
        side: "over", align: "center",
      },
    },
  },
];

// ─── Storage helpers ──────────────────────────────────────────────────
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

const KEY_BIENVENIDA = "__bienvenida__";

/**
 * Lanza el tour del usuario. Recibe navigate de react-router para que los
 * steps con `route` puedan llevarte a esa pantalla automáticamente.
 *
 * - permisos: lista de slugs efectivos del user
 * - userId: para flag de "ya visto" en localStorage
 * - navigate: callback de react-router-dom useNavigate()
 * - opts.force: ignora flags y muestra todo (usado por botón "Ver tour" en Ajustes)
 */
export function lanzarTour(
  permisos: string[],
  userId: number,
  navigate: NavigateFn,
  opts: { force?: boolean } = {},
): void {
  const seen = opts.force ? new Set<string>() : getSeenPermisos(userId);
  const vioBienvenida = seen.has(KEY_BIENVENIDA);
  const permisosNuevos = permisos.filter(p => !seen.has(p));

  if (vioBienvenida && permisosNuevos.length === 0 && !opts.force) return;

  const allSteps: PaseStep[] = [];

  if (!vioBienvenida || opts.force) {
    allSteps.push(...BIENVENIDA);
  } else {
    allSteps.push({
      route: "/inicio",
      step: {
        popover: {
          title: "🆕 Permisos nuevos",
          description: `Te asignaron permisos nuevos desde la última vez. Vamos a mostrarte qué hacés en cada uno.`,
          side: "over", align: "center",
        },
      },
    });
  }

  // Tours por permiso (en el orden que vienen los permisos)
  const slugsAMostrar = permisosNuevos.length > 0 ? permisosNuevos : permisos;
  for (const slug of slugsAMostrar) {
    const tour = TOURS_POR_PERMISO[slug];
    if (tour && tour.length > 0) allSteps.push(...tour);
  }

  if (!vioBienvenida || opts.force) {
    allSteps.push(...CIERRE);
  }

  if (allSteps.length === 0) return;

  // Convertir PaseStep[] → DriveStep[] con hooks de navegación.
  const driveSteps: DriveStep[] = allSteps.map((s) => ({
    ...s.step,
    // onHighlightStarted dispara ANTES de que el spotlight aparezca —
    // perfecto para navegar primero. Si la ruta actual ya es esa, no
    // hace nada (evita reloads innecesarios).
    onHighlightStarted: (element, step, options) => {
      if (s.route && window.location.pathname !== s.route) {
        navigate(s.route);
      }
      // Llamar hook original si la step lo definió
      if (s.step.onHighlightStarted) s.step.onHighlightStarted(element, step, options);
    },
  }));

  const d = driver({
    showProgress: true,
    progressText: "{{current}} de {{total}}",
    nextBtnText: "Siguiente →",
    prevBtnText: "← Anterior",
    doneBtnText: "Listo",
    overlayOpacity: 0.65,
    // Delay entre steps para esperar que la nueva ruta se renderice
    // antes de calcular posición del element.
    animate: true,
    smoothScroll: true,
    steps: driveSteps,
    onDestroyed: () => {
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
