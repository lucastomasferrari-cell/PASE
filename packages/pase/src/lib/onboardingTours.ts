/**
 * onboardingTours.ts — definiciones de tours guiados por rol.
 *
 * Usa driver.js (~5KB gzip, sin deps) para overlay con spotlight + tooltips.
 * Cada paso apunta a un selector CSS de la pantalla (data-tour="..." atribute
 * que vamos sumando a los elementos relevantes) o muestra modal libre.
 *
 * El tour arranca automático la primera vez que un usuario entra. Trigger:
 * flag `pase_onboarding_done_<userId>` en localStorage. Reproducible
 * manualmente desde Ajustes → "Ver tour de bienvenida".
 *
 * Pedido Lucas 2026-05-17: parte de bajar la fricción de onboarding, junto
 * con la pantalla de migración masiva (commit 5b1ba89). Sin tour, un dueño
 * nuevo no sabe por dónde empezar.
 */

import { driver, type DriveStep } from "driver.js";
import "driver.js/dist/driver.css";

export type RolTour = "dueno" | "admin" | "encargado" | "cajero" | "superadmin" | "compras";

// ─── Tour del dueño/admin (completo) ───────────────────────────────────
// Cubre la "primera operación": importar data, configurar dashboards,
// cargar objetivos. ~7 pasos, 90s.

const TOUR_DUENO: DriveStep[] = [
  {
    popover: {
      title: "¡Bienvenido a PASE!",
      description: `Te damos un tour rápido (≈ 1 min) para que conozcas las funciones principales.<br /><br />
        Podés saltearlo y verlo después desde <strong>Ajustes → Ver tour</strong>.`,
      side: "over",
      align: "center",
    },
  },
  {
    element: "[data-tour='sidebar-local']",
    popover: {
      title: "Sucursal activa",
      description: `Acá elegís sobre qué sucursal trabajás. <strong>Todo lo que veas y cargues va a esa sucursal.</strong><br /><br />
        Para ver otra, cambiala con este selector.`,
      side: "right",
    },
  },
  {
    element: "[data-tour='sidebar-nav']",
    popover: {
      title: "Módulos",
      description: `<strong>Operación</strong>: día a día (caja, ventas, compras, gastos).<br />
        <strong>Dirección</strong>: vista ejecutiva, objetivos, reportes.<br />
        <strong>Herramientas</strong>: importar data, configurar dashboards, contador/IVA.<br />
        <strong>Sistema</strong>: ajustes y usuarios.`,
      side: "right",
    },
  },
  {
    popover: {
      title: "Primer paso: importá tu data vieja",
      description: `Si venís de otro sistema, no tenés que cargar todo a mano.<br /><br />
        Andá a <strong>Herramientas → Importar data</strong> y subí CSVs con proveedores, empleados y conceptos.<br /><br />
        Hay plantillas listas para descargar.`,
      side: "over",
      align: "center",
    },
  },
  {
    popover: {
      title: "Segundo paso: cargá los objetivos del mes",
      description: `En <strong>Dirección → Objetivos</strong> definís facturación objetivo + costos fijos + margen esperado.<br /><br />
        Con esto el dashboard te muestra el % de avance y el punto de equilibrio en tiempo real.`,
      side: "over",
      align: "center",
    },
  },
  {
    popover: {
      title: "Tercer paso: configurá los dashboards",
      description: `Desde <strong>Herramientas → Configurar dashboards</strong> elegís qué widgets ve cada empleado en su pantalla de inicio.<br /><br />
        El cajero ve saldos y ventas del día, el de compras ve facturas vencidas, vos ves todo.`,
      side: "over",
      align: "center",
    },
  },
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
      description: `Ya conocés lo básico. Empezá por <strong>Importar data</strong> si tenés clientes/empleados que pasar.<br /><br />
        Para repetir este tour: <strong>Ajustes → Ver tour de bienvenida</strong>.`,
      side: "over",
      align: "center",
    },
  },
];

// ─── Tour del encargado (corto) ─────────────────────────────────────────
// Foco: caja, ventas, gastos. Sin importar data ni configurar usuarios.

const TOUR_ENCARGADO: DriveStep[] = [
  {
    popover: {
      title: "¡Bienvenido a PASE!",
      description: `Te damos un tour rápido (≈ 30s) para que sepas lo esencial de tu día.`,
      side: "over", align: "center",
    },
  },
  {
    element: "[data-tour='sidebar-local']",
    popover: {
      title: "Tu sucursal",
      description: `Si tenés más de una sucursal asignada, elegís acá sobre cuál trabajás.`,
      side: "right",
    },
  },
  {
    element: "[data-tour='sidebar-nav']",
    popover: {
      title: "Lo que vas a usar",
      description: `<strong>Caja</strong>: cargar movimientos y ver saldos.<br />
        <strong>Ventas</strong>: cargar el cierre del turno.<br />
        <strong>Gastos</strong>: cargar gastos del local.<br />
        <strong>Equipo</strong>: ver empleados.`,
      side: "right",
    },
  },
  {
    popover: {
      title: "Tu inicio",
      description: `En esta pantalla ves los widgets que el dueño configuró para vos. Si querés que aparezca algo más, pedíselo.`,
      side: "over", align: "center",
    },
  },
  {
    popover: {
      title: "¡Listo!",
      description: `Cualquier duda escribime o pasá el mouse sobre el ícono ☼ al lado de los títulos.`,
      side: "over", align: "center",
    },
  },
];

// ─── Tour del cajero/compras (mini) ─────────────────────────────────────

const TOUR_CAJERO: DriveStep[] = [
  {
    popover: {
      title: "¡Bienvenido!",
      description: `Tour ultra-rápido (≈ 20s).`,
      side: "over", align: "center",
    },
  },
  {
    element: "[data-tour='sidebar-nav']",
    popover: {
      title: "Tus tareas",
      description: `Vas a usar <strong>Caja</strong> (cargar movimientos, ver saldos) y <strong>Ventas</strong> (cierres).`,
      side: "right",
    },
  },
  {
    popover: {
      title: "Tu inicio",
      description: `Saldos y ventas del día están en esta pantalla. ¡Empezá!`,
      side: "over", align: "center",
    },
  },
];

const TOURS: Record<RolTour, DriveStep[]> = {
  dueno: TOUR_DUENO,
  admin: TOUR_DUENO,
  superadmin: TOUR_DUENO,
  encargado: TOUR_ENCARGADO,
  cajero: TOUR_CAJERO,
  compras: TOUR_CAJERO, // mismo nivel de simplicidad
};

/**
 * Lanza el tour correspondiente al rol del usuario. Si ya lo vio (flag en
 * localStorage), no hace nada salvo que se llame con `force: true` (botón
 * "Ver tour" en Ajustes).
 */
export function lanzarTour(rol: RolTour, userId: number, opts: { force?: boolean } = {}): void {
  const key = `pase_onboarding_done_${userId}`;
  if (!opts.force && localStorage.getItem(key) === "1") return;

  const steps = TOURS[rol] ?? TOUR_ENCARGADO;
  const d = driver({
    showProgress: true,
    progressText: "{{current}} de {{total}}",
    nextBtnText: "Siguiente →",
    prevBtnText: "← Anterior",
    doneBtnText: "Listo",
    overlayOpacity: 0.65,
    steps,
    onDestroyed: () => {
      // Marcar como visto solo si el user terminó (o cerró voluntariamente).
      // El primer trigger automático lo guarda; los manuales (force) también.
      localStorage.setItem(key, "1");
    },
  });
  d.drive();
}

/** Resetea el flag para que el tour vuelva a salir automático en el próximo /inicio. */
export function resetTour(userId: number): void {
  localStorage.removeItem(`pase_onboarding_done_${userId}`);
}
