// Hooks de datos para la pantalla Finanzas.
//
// Por ahora retornan data MOCK realista (gastronomía argentina tipo Neko).
// La segunda iteración conectará a:
//   - useFinanzasConsolidado: agrega ventas + facturas + gastos + saldos_caja
//     cruzando todos los locales del tenant (RLS + applyLocalScope sin local).
//   - useLocalFinanzas: misma agregación pero filtrada por local_id.
//   - useVencimientos: facturas no pagadas + servicios recurrentes con
//     fecha de vencimiento <= hoy + N días.
//
// NO incluir Mercado Pago ni cuentas bancarias en estos hooks hasta que la
// conciliación esté operativa. Solo efectivo en caja (saldos_caja con
// cuenta="Caja Efectivo" o equivalente).

import type { LocalCardProps } from "../components/ui/LocalCard";

export interface FinanzasConsolidado {
  efectivoTotal: number;
  flow: { entro: number; salio: number; resultado: number };
  porPagar30d: { total: number; estaSemana: number; spark: number[] };
  cierreProyectado: { total: number; sub: string; spark: number[] };
  margenBruto: { value: string; delta: string; spark: number[] };
}

export interface Vencimiento {
  id: string;
  dia: number;
  mes: string;
  /** true si vence en <=7 días (date box pintada celeste) */
  inminente: boolean;
  nombre: string;
  descripcion: string;
  local: { nombre: string; tone: "primary" | "muted" };
  monto: number;
  diasRestantes: number;
}

/** Datos consolidados (cross-local) del tenant. Mock. */
export function useFinanzasConsolidado(): FinanzasConsolidado {
  return {
    efectivoTotal: 1_240_000,
    flow: { entro: 28_450_000, salio: 26_110_000, resultado: 2_340_000 },
    porPagar30d: {
      total: 4_820_000,
      estaSemana: 1_100_000,
      spark: [22, 28, 36, 30, 48, 42, 58],
    },
    cierreProyectado: {
      total: 3_180_000,
      sub: "Resultado proyectado fin de mes",
      spark: [40, 38, 44, 42, 50, 54, 62],
    },
    margenBruto: {
      value: "41.6%",
      delta: "+ 1.8 pts vs. abril",
      spark: [34, 36, 38, 36, 40, 41, 42],
    },
  };
}

/** Lista de locales con sus datos financieros del mes. Mock con 2. */
export function useLocalFinanzas(): LocalCardProps[] {
  return [
    {
      name: "Belgrano",
      badge: { text: "líder", variant: "default" },
      variant: "leading",
      metaInfo: "42 días operados · 12 personas",
      facturacionMes: 14_800_000,
      flow: { entro: 17_220_000, salio: 14_720_000, resultado: 2_500_000 },
      kpis: {
        margen:     { value: "44.2%", delta: "+2.1 pts", tone: "up" },
        ticketProm: { value: 4_820, delta: "+4.8% vs. abril", tone: "up" },
        tickets:    { value: 1_842, delta: "+6.2% vs. abril", tone: "up" },
      },
      spark7d: [38, 42, 50, 46, 58, 64, 72],
      spark7dLastAmount: 612_400,
      efectivoCaja: 780_000,
      venceSemana: { amount: 0, warn: false },
    },
    {
      name: "Villa Crespo",
      badge: { text: "debajo del ritmo", variant: "warn" },
      variant: "behind",
      metaInfo: "42 días operados · 9 personas",
      facturacionMes: 11_200_000,
      flow: { entro: 13_410_000, salio: 12_870_000, resultado: 540_000 },
      kpis: {
        margen:     { value: "38.1%", delta: "−1.4 pts", tone: "warn" },
        ticketProm: { value: 4_230, delta: "+1.1% vs. abril", tone: "up" },
        tickets:    { value: 1_452, delta: "−3.8% vs. abril", tone: "warn" },
      },
      spark7d: [44, 38, 42, 36, 46, 40, 48],
      spark7dLastAmount: 408_900,
      efectivoCaja: 460_000,
      venceSemana: { amount: 1_120_000, warn: true },
    },
  ];
}

/** Próximos vencimientos (facturas / servicios recurrentes). Mock. */
export function useVencimientos(): Vencimiento[] {
  return [
    {
      id: "v1",
      dia: 16, mes: "MAY",
      inminente: true,
      nombre: "Provid SA",
      descripcion: "Insumos cocina · Belgrano",
      local: { nombre: "Belgrano", tone: "primary" },
      monto: 412_300,
      diasRestantes: 3,
    },
    {
      id: "v2",
      dia: 18, mes: "MAY",
      inminente: true,
      nombre: "Edesur",
      descripcion: "Servicio eléctrico · Ambos locales",
      local: { nombre: "Ambos", tone: "muted" },
      monto: 286_500,
      diasRestantes: 5,
    },
    {
      id: "v3",
      dia: 20, mes: "MAY",
      inminente: true,
      nombre: "Don Carmelo",
      descripcion: "Frutas y verduras · Villa Crespo",
      local: { nombre: "Villa Crespo", tone: "muted" },
      monto: 184_700,
      diasRestantes: 7,
    },
    {
      id: "v4",
      dia: 25, mes: "MAY",
      inminente: false,
      nombre: "AFIP — IVA",
      descripcion: "Posición mensual · Ambos locales",
      local: { nombre: "Ambos", tone: "muted" },
      monto: 1_240_000,
      diasRestantes: 12,
    },
    {
      id: "v5",
      dia: 28, mes: "MAY",
      inminente: false,
      nombre: "Aguas Argentinas",
      descripcion: "Servicio · Belgrano",
      local: { nombre: "Belgrano", tone: "primary" },
      monto: 68_900,
      diasRestantes: 15,
    },
    {
      id: "v6",
      dia: 31, mes: "MAY",
      inminente: false,
      nombre: "Alquiler Belgrano",
      descripcion: "Mensualidad",
      local: { nombre: "Belgrano", tone: "primary" },
      monto: 1_850_000,
      diasRestantes: 18,
    },
  ];
}
